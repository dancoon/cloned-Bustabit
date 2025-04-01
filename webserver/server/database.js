const assert = require('assert');
const uuid = require('uuid');
const config = require('../config/config');
const async = require('async');
const { Pool } = require('pg');
const passwordHash = require('password-hash');
const speakeasy = require('speakeasy');
const m = require('multiline');

const databaseUrl = config.DATABASE_URL;

if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable must be set');
}

console.log('DATABASE_URL: ', databaseUrl);

const pool = new Pool({
    connectionString: databaseUrl,
    // Add any other pool configurations from your config here, if needed.
});

pool.on('error', err => {
    console.error('PostgreSQL Pool Error:', err);
});

// Database Query Functions

async function query(queryString, params = []) {
    const client = await pool.connect();
    try {
        const result = await client.query(queryString, params);
        return result;
    } finally {
        client.release();
    }
}

async function getClient(runner) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const data = await runner(client);
        await client.query('COMMIT');
        return data;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err; // Rethrow the error to be handled by the caller
    } finally {
        client.release();
    }
}

// User Management Functions

exports.createUser = async (username, password, email, ipAddress, userAgent) => {
    assert(username && password);

    return getClient(async client => {
        const hashedPassword = passwordHash.generate(password);

        const countResult = await client.query('SELECT COUNT(*) count FROM users WHERE LOWER(username) = LOWER($1)', [username]);
        assert(countResult.rows.length === 1);
        if (countResult.rows[0].count > 0) throw 'USERNAME_TAKEN';

        const insertResult = await client.query('INSERT INTO users(username, email, password) VALUES($1, $2, $3) RETURNING id', [username, email, hashedPassword]);
        assert(insertResult.rows.length === 1);
        const user = insertResult.rows[0];

        return createSession(client, user.id, ipAddress, userAgent, false);
    });
};

exports.updateEmail = async (userId, email) => {
    assert(userId);
    const res = await query('UPDATE users SET email = $1 WHERE id = $2', [email, userId]);
    assert(res.rowCount === 1);
};

exports.changeUserPassword = async (userId, password) => {
    assert(userId && password);
    const hashedPassword = passwordHash.generate(password);
    const res = await query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, userId]);
    assert(res.rowCount === 1);
};

exports.updateMfa = async (userId, secret) => {
    assert(userId);
    await query('UPDATE users SET mfa_secret = $1 WHERE id = $2', [secret, userId]);
};

exports.validateUser = async (username, password, otp) => {
    assert(username && password);

    const data = await query('SELECT id, password, mfa_secret FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    if (data.rows.length === 0) throw 'NO_USER';

    const user = data.rows[0];
    if (!passwordHash.verify(password, user.password)) throw 'WRONG_PASSWORD';

    if (user.mfa_secret) {
        if (!otp) throw 'INVALID_OTP';
        const expected = speakeasy.totp({ key: user.mfa_secret, encoding: 'base32' });
        if (otp !== expected) throw 'INVALID_OTP';
    }

    return user.id;
};

exports.expireSessionsByUserId = async (userId) => {
    assert(userId);
    await query('UPDATE sessions SET expired = NOW() WHERE user_id = $1 AND expired > NOW()', [userId]);
};

async function createSession(client, userId, ipAddress, userAgent, remember) {
    const sessionId = uuid.v4();
    const expired = new Date();
    expired.setDate(expired.getDate() + (remember ? 3650 : 21)); // 10 years or 21 days

    const res = await client.query('INSERT INTO sessions(id, user_id, ip_address, user_agent, expired) VALUES($1, $2, $3, $4, $5) RETURNING id', [sessionId, userId, ipAddress, userAgent, expired]);
    assert(res.rows.length === 1);
    const session = res.rows[0];
    assert(session.id);
    return { sessionId: session.id, expired };
}

exports.createOneTimeToken = async (userId, ipAddress, userAgent) => {
    assert(userId);
    const id = uuid.v4();

    const result = await query('INSERT INTO sessions(id, user_id, ip_address, user_agent, ott) VALUES($1, $2, $3, $4, true) RETURNING id', [id, userId, ipAddress, userAgent]);
    assert(result.rows.length === 1);
    const ott = result.rows[0];
    return ott.id;
};

exports.createSession = async (userId, ipAddress, userAgent, remember) => {
    assert(userId);
    return getClient(async client => createSession(client, userId, ipAddress, userAgent, remember));
};

exports.getUserFromUsername = async (username) => {
    assert(username);
    const data = await query('SELECT * FROM users_view WHERE LOWER(username) = LOWER($1)', [username]);
    if (data.rows.length === 0) throw 'NO_USER';
    assert(data.rows.length === 1);
    const user = data.rows[0];
    assert(typeof user.balance_satoshis === 'number');
    return user;
};

exports.getUsersFromEmail = async (email) => {
    assert(email);
    const data = await query('select * from users where email = lower($1)', [email]);
    if (data.rows.length === 0) throw 'NO_USERS';
    return data.rows;
};

exports.addRecoverId = async (userId, ipAddress) => {
    assert(userId && ipAddress);
    const recoveryId = uuid.v4();
    await query('INSERT INTO recovery (id, user_id, ip)  values($1, $2, $3)', [recoveryId, userId, ipAddress]);
    return recoveryId;
};

exports.getUserBySessionId = async (sessionId) => {
    assert(sessionId);
    const response = await query('SELECT * FROM users_view WHERE id = (SELECT user_id FROM sessions WHERE id = $1 AND ott = false AND expired > NOW())', [sessionId]);
    const data = response.rows;
    if (data.length === 0) throw 'NOT_VALID_SESSION';
    assert(data.length === 1);
    const user = data[0];
    assert(typeof user.balance_satoshis === 'number');
    return user;
};

exports.getUserByValidRecoverId = async (recoverId) => {
    assert(recoverId);
    const res = await query('SELECT * FROM users_view WHERE id = (SELECT user_id FROM recovery WHERE id = $1 AND used = false AND expired > NOW())', [recoverId]);
    const data = res.rows;
    if (data.length === 0) throw 'NOT_VALID_RECOVER_ID';
    assert(data.length === 1);
    return data[0];
};

exports.getUserByName = async (username) => {
    assert(username);
    const result = await query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    if (result.rows.length === 0) throw 'USER_DOES_NOT_EXIST';
    assert(result.rows.length === 1);
    return result.rows[0];
};

exports.changePasswordFromRecoverId = async (recoverId, password) => {
    assert(recoverId && password);
    const hashedPassword = passwordHash.generate(password);

    const sql = m(function() {
        /*
        WITH t as (UPDATE recovery SET used = true, expired = now()
        WHERE id = $1 AND used = false AND expired > now()
        RETURNING *) UPDATE users SET password = $2 where id = (SELECT user_id FROM t) RETURNING *
        */
    });

    const res = await query(sql, [recoverId, hashedPassword]);
    const data = res.rows;
    if (data.length === 0) throw 'NOT_VALID_RECOVER_ID';
    assert(data.length === 1);
    return data[0];
};

// ... (rest of the functions remain mostly the same, but using async/await and pool.query)
// ...