var assert = require('assert');
var uuid = require('uuid');
var async = require('async');
var lib = require('./lib');
var { Pool, types } = require('pg');
var config = require('./config');

// Ensure DATABASE_URL environment variable is set
if (!config.DATABASE_URL)
    throw new Error('must set DATABASE_URL environment var');

console.log('DATABASE_URL: ', config.DATABASE_URL);

// Configure database connection parameters
const dbConfig = {
    connectionString: config.DATABASE_URL,
    ssl: {
        rejectUnauthorized: true,
        require: true
    },
    max: 5, // Reduced to prevent overwhelming the pooler
    idleTimeoutMillis: 10000, // Reduced to prevent stale connections
    connectionTimeoutMillis: 10000, // Increased to give more time for connection
    statement_timeout: 30000, // 30 second statement timeout
    query_timeout: 30000, // 30 second query timeout
    application_name: 'moneypot_game_server', // Helps with connection tracking
    keepalive: true, // Enable TCP keepalive
    keepaliveInitialDelayMillis: 10000, // Initial delay before sending keepalive
    keepaliveIntervalMillis: 10000, // Interval between keepalive packets
    keepaliveCount: 3 // Number of keepalive packets to send before giving up
};

// Configure type parsers for PostgreSQL
types.setTypeParser(20, val => val === null ? null : parseInt(val)); // int8 -> integer
types.setTypeParser(1700, val => val === null ? null : parseFloat(val)); // numeric -> float

// Create the pool
const pool = new Pool(dbConfig);

// Handle pool errors
pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
    // Don't exit process on pool error, just log it
    console.error('Pool error:', err);
});

// Database operations class
class Database {
    constructor() {
        this.pool = pool;
        this.maxRetries = 5; // Increased from 3 to 5
        this.retryDelay = 2000; // Increased from 1000 to 2000ms
    }

    // Execute a query with optional parameters and retry logic
    async query(sql, params = []) {
        let lastError;
        
        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            const client = await this.pool.connect();
            try {
                const result = await client.query(sql, params);
                client.release();
                return result;
            } catch (err) {
                client.release();
                lastError = err;
                
                // If it's a deadlock, retry immediately
                if (err.code === '40P01') {
                    console.log(`Warning: Retrying deadlocked transaction (attempt ${attempt}/${this.maxRetries}):`, sql);
                    continue;
                }
                
                // If it's a connection error, wait before retrying
                if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'PROTOCOL_CONNECTION_LOST' || err.message.includes('timeout')) {
                    console.log(`Warning: Connection error (attempt ${attempt}/${this.maxRetries}), retrying in ${this.retryDelay}ms:`, err.message);
                    await new Promise(resolve => setTimeout(resolve, this.retryDelay));
                    continue;
                }
                
                // For other errors, throw immediately
                throw err;
            }
        }
        
        throw lastError;
    }

    // Execute a transaction with retry logic
    async transaction(callback) {
        let lastError;
        
        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            const client = await this.pool.connect();
            try {
                await client.query('BEGIN');
                const result = await callback(client);
                await client.query('COMMIT');
                client.release();
                return result;
            } catch (err) {
                await client.query('ROLLBACK');
                client.release();
                lastError = err;
                
                // If it's a deadlock, retry immediately
                if (err.code === '40P01') {
                    console.log(`Warning: Retrying deadlocked transaction (attempt ${attempt}/${this.maxRetries})`);
                    continue;
                }
                
                // If it's a connection error, wait before retrying
                if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'PROTOCOL_CONNECTION_LOST') {
                    console.log(`Warning: Connection error (attempt ${attempt}/${this.maxRetries}), retrying in ${this.retryDelay}ms:`, err.message);
                    await new Promise(resolve => setTimeout(resolve, this.retryDelay));
                    continue;
                }
                
                // For other errors, throw immediately
                throw err;
            }
        }
        
        throw lastError;
    }

    // Get a client from the pool for custom operations
    async getClient() {
        return await this.pool.connect();
    }

    // End the pool
    async end() {
        await this.pool.end();
    }
}

// Create database instance
const db = new Database();

// Game-related queries
const gameQueries = {
    async getLastGameInfo() {
        const result = await db.query('SELECT MAX(id) id FROM games');
        const id = result.rows[0].id;

        if (!id || id < 1e6) {
            return {
                id: 1e6 - 1,
                hash: 'c1cfa8e28fc38999eaa888487e443bad50a65e0b710f649affa6718cfbfada4d'
            };
        }

        const hashResult = await db.query('SELECT hash FROM game_hashes WHERE game_id = $1', [id]);
        return { id, hash: hashResult.rows[0].hash };
    },

    async createGame(gameId ) {
        console.log('gameId', gameId);
        const result = await db.query('SELECT hash FROM game_hashes WHERE game_id = $1', [gameId]);
        
        if (result.rows.length !== 1) {
            throw new Error('NO_GAME_HASH');
        }

        const hash = result.rows[0].hash;
        const gameCrash = lib.crashPointFromHash(hash);
        
        await db.query('INSERT INTO games(id, game_crash) VALUES($1, $2)', [gameId, gameCrash]);
        return { crashPoint: gameCrash, hash };
    },

    async endGame(gameId, bonuses) {
        return db.transaction(async (client) => {
            await client.query('UPDATE games SET ended = true WHERE id = $1', [gameId]);

            if (bonuses.length === 0) return;

            const userIds = bonuses.map(b => b.user.id);
            const playIds = bonuses.map(b => b.playId);
            const bonusesAmounts = bonuses.map(b => b.amount);

            const result = await client.query(endGameQuery, [userIds, playIds, bonusesAmounts]);
            
            if (result.rows[0].count !== userIds.length) {
                throw new Error(`Mismatch row count: ${result.rows[0].count} and ${userIds.length}`);
            }
        });
    },

    async getGameHistory() {
        const sql = `
            SELECT games.id game_id, game_crash, created,
                   (SELECT hash FROM game_hashes WHERE game_id = games.id),
                   (SELECT to_json(array_agg(to_json(pv)))
                    FROM (SELECT username, bet, (100 * cash_out / bet) AS stopped_at, bonus
                          FROM plays JOIN users ON user_id = users.id
                          WHERE game_id = games.id) pv) player_info
            FROM games
            WHERE games.ended = true
            ORDER BY games.id DESC LIMIT 10
        `;

        const result = await db.query(sql);
        return result.rows.map(row => {
            const oldInfo = row.player_info || [];
            const newInfo = {};
            
            oldInfo.forEach(play => {
                newInfo[play.username] = {
                    bet: play.bet,
                    stopped_at: play.stopped_at,
                    bonus: play.bonus
                };
            });
            
            row.player_info = newInfo;
            return row;
        });
    }
};

// User-related queries
const userQueries = {
    async getUserByName(username) {
        const result = await db.query(
            'SELECT * FROM users WHERE lower(username) = lower($1)',
            [username]
        );

        if (result.rows.length === 0) {
            throw new Error('USER_DOES_NOT_EXIST');
        }

        return result.rows[0];
    },

    async validateOneTimeToken(token) {
        const result = await db.query(
            `WITH t as (UPDATE sessions SET expired = now() 
             WHERE id = $1 AND ott = TRUE RETURNING *)
             SELECT * FROM users WHERE id = (SELECT user_id FROM t)`,
            [token]
        );

        if (result.rowCount === 0) {
            throw new Error('NOT_VALID_TOKEN');
        }

        return result.rows[0];
    },

    async placeBet(amount, autoCashOut, userId, gameId) {
        return db.transaction(async (client) => {
            await client.query(
                'UPDATE users SET balance_satoshis = balance_satoshis - $1 WHERE id = $2',
                [amount, userId]
            );

            const result = await client.query(
                'INSERT INTO plays(user_id, game_id, bet, auto_cash_out) VALUES($1, $2, $3, $4) RETURNING id',
                [userId, gameId, amount, autoCashOut]
            );

            return result.rows[0].id;
        });
    },

    async cashOut(userId, playId, amount) {
        return db.transaction(async (client) => {
            await client.query(
                'UPDATE users SET balance_satoshis = balance_satoshis + $1 WHERE id = $2',
                [amount, userId]
            );

            const result = await client.query(
                'UPDATE plays SET cash_out = $1 WHERE id = $2 AND cash_out IS NULL',
                [amount, playId]
            );

            if (result.rowCount !== 1) {
                throw new Error('Double cashout');
            }
        });
    },

    async getBankroll() {
        const result = await db.query(`
            SELECT (
                (SELECT COALESCE(SUM(amount),0) FROM fundings) -
                (SELECT COALESCE(SUM(balance_satoshis), 0) FROM users)
            ) AS profit
        `);

        const profit = result.rows[0].profit - 100e8;
        const min = 1e8;
        return Math.max(min, profit);
    }
};

// SQL queries
const endGameQuery = `
    WITH vals AS (
        SELECT
            unnest($1::bigint[]) as user_id,
            unnest($2::bigint[]) as play_id,
            unnest($3::bigint[]) as bonus
    ),
    p AS (
        UPDATE plays 
        SET bonus = vals.bonus 
        FROM vals 
        WHERE id = vals.play_id 
        RETURNING vals.user_id
    ),
    u AS (
        UPDATE users 
        SET balance_satoshis = balance_satoshis + vals.bonus
        FROM vals 
        WHERE id = vals.user_id 
        RETURNING vals.user_id
    )
    SELECT COUNT(*) count 
    FROM p 
    JOIN u ON p.user_id = u.user_id
`;

// Export the refactored functions
module.exports = {
    ...gameQueries,
    ...userQueries,
    query: db.query.bind(db),
    transaction: db.transaction.bind(db),
    end: db.end.bind(db) // Add this to properly close the pool when shutting down
};
