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

exports.changeUserPassword = function(userId, password, callback) {
    assert(userId && password && callback);
    var hashedPassword = passwordHash.generate(password);
    query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, userId], function(err, res) {
        if (err) return callback(err);
        assert(res.rowCount === 1);
        callback(null);
    });
};

exports.updateMfa = function(userId, secret, callback) {
    assert(userId);
    query('UPDATE users SET mfa_secret = $1 WHERE id = $2', [secret, userId], callback);
};

// Possible errors:
//   NO_USER, WRONG_PASSWORD, INVALID_OTP
exports.validateUser = function(username, password, otp, callback) {
    assert(username && password);

    query('SELECT id, password, mfa_secret FROM users WHERE lower(username) = lower($1)', [username], function (err, data) {
        if (err) return callback(err);

        if (data.rows.length === 0)
            return callback('NO_USER');

        var user = data.rows[0];

        var verified = passwordHash.verify(password, user.password);
        if (!verified)
            return callback('WRONG_PASSWORD');

        if (user.mfa_secret) {
            if (!otp) return callback('INVALID_OTP'); // really, just needs one

            var expected = speakeasy.totp({ key: user.mfa_secret, encoding: 'base32' });

            if (otp !== expected)
                return callback('INVALID_OTP');
        }

        callback(null, user.id);
    });
};

/** Expire all the not expired sessions of an user by id **/
exports.expireSessionsByUserId = function(userId, callback) {
    assert(userId);

    query('UPDATE sessions SET expired = now() WHERE user_id = $1 AND expired > now()', [userId], callback);
};


function createSession(client, userId, ipAddress, userAgent, remember, callback) {
    var sessionId = uuid.v4();

    var expired = new Date();
    if (remember)
        expired.setFullYear(expired.getFullYear() + 10);
    else
        expired.setDate(expired.getDate() + 21);

    client.query('INSERT INTO sessions(id, user_id, ip_address, user_agent, expired) VALUES($1, $2, $3, $4, $5) RETURNING id',
        [sessionId, userId, ipAddress, userAgent, expired], function(err, res) {
        if (err) return callback(err);
        assert(res.rows.length === 1);

        var session = res.rows[0];
        assert(session.id);

        callback(null, session.id, expired);
    });
}

exports.createOneTimeToken = function(userId, ipAddress, userAgent, callback) {
    assert(userId);
    var id = uuid.v4();

    query('INSERT INTO sessions(id, user_id, ip_address, user_agent, ott) VALUES($1, $2, $3, $4, true) RETURNING id', [id, userId, ipAddress, userAgent], function(err, result) {
        if (err) return callback(err);
        assert(result.rows.length === 1);

        var ott = result.rows[0];

        callback(null, ott.id);
    });
};

exports.createSession = function(userId, ipAddress, userAgent, remember, callback) {
    assert(userId && callback);

    getClient(function(client, callback) {
        createSession(client, userId, ipAddress, userAgent, remember, callback);
    }, callback);

};

exports.getUserFromUsername = function(username, callback) {
    assert(username && callback);

    query('SELECT * FROM users_view WHERE lower(username) = lower($1)', [username], function(err, data) {
        if (err) return callback(err);

        if (data.rows.length === 0)
            return callback('NO_USER');

        assert(data.rows.length === 1);
        var user = data.rows[0];
        assert(typeof user.balance_satoshis === 'number');

        callback(null, user);
    });
};

exports.getUsersFromEmail = function(email, callback) {
    assert(email, callback);

    query('select * from users where email = lower($1)', [email], function(err, data) {
       if (err) return callback(err);

        if (data.rows.length === 0)
            return callback('NO_USERS');

        callback(null, data.rows);

    });
};

exports.addRecoverId = function(userId, ipAddress, callback) {
    assert(userId && ipAddress && callback);

    var recoveryId = uuid.v4();

    query('INSERT INTO recovery (id, user_id, ip)  values($1, $2, $3)', [recoveryId, userId, ipAddress], function(err, res) {
        if (err) return callback(err);
        callback(null, recoveryId);
    });
};

exports.getUserBySessionId = function(sessionId, callback) {
    assert(sessionId && callback);
    query('SELECT * FROM users_view WHERE id = (SELECT user_id FROM sessions WHERE id = $1 AND ott = false AND expired > now())', [sessionId], function(err, response) {
        if (err) return callback(err);

        var data = response.rows;
        if (data.length === 0)
            return callback('NOT_VALID_SESSION');

        assert(data.length === 1);

        var user = data[0];
        assert(typeof user.balance_satoshis === 'number');

        callback(null, user);
    });
};

exports.getUserByValidRecoverId = function(recoverId, callback) {
    assert(recoverId && callback);
    query('SELECT * FROM users_view WHERE id = (SELECT user_id FROM recovery WHERE id = $1 AND used = false AND expired > NOW())', [recoverId], function(err, res) {
        if (err) return callback(err);

        var data = res.rows;
        if (data.length === 0)
            return callback('NOT_VALID_RECOVER_ID');

        assert(data.length === 1);
        return callback(null, data[0]);
    });
};

exports.getUserByName = function(username, callback) {
    assert(username);
    query('SELECT * FROM users WHERE lower(username) = lower($1)', [username], function(err, result) {
        if (err) return callback(err);
        if (result.rows.length === 0)
            return callback('USER_DOES_NOT_EXIST');

        assert(result.rows.length === 1);
        callback(null, result.rows[0]);
    });
};

/* Sets the recovery record to userd and update password */
exports.changePasswordFromRecoverId = function(recoverId, password, callback) {
    assert(recoverId && password && callback);
    var hashedPassword = passwordHash.generate(password);

    var sql = m(function() {/*
     WITH t as (UPDATE recovery SET used = true, expired = now()
     WHERE id = $1 AND used = false AND expired > now()
     RETURNING *) UPDATE users SET password = $2 where id = (SELECT user_id FROM t) RETURNING *
     */});

    query(sql, [recoverId, hashedPassword], function(err, res) {
            if (err)
                return callback(err);

            var data = res.rows;
            if (data.length === 0)
                return callback('NOT_VALID_RECOVER_ID');

            assert(data.length === 1);

            callback(null, data[0]);
        }
    );
};

exports.getGame = function(gameId, callback) {
    assert(gameId && callback);

    query('SELECT * FROM games ' +
    'LEFT JOIN game_hashes ON games.id = game_hashes.game_id ' +
    'WHERE games.id = $1 AND games.ended = TRUE', [gameId], function(err, result) {
        if (err) return callback(err);
        if (result.rows.length == 0) return callback('GAME_DOES_NOT_EXISTS');
        assert(result.rows.length == 1);
        callback(null, result.rows[0]);
    });
};

exports.getGamesPlays = function(gameId, callback) {
    query('SELECT u.username, p.bet, p.cash_out, p.bonus FROM plays p, users u ' +
        ' WHERE game_id = $1 AND p.user_id = u.id ORDER by p.cash_out/p.bet::float DESC NULLS LAST, p.bet DESC', [gameId],
        function(err, result) {
            if (err) return callback(err);
            return callback(null, result.rows);
        }
    );
};

function addSatoshis(client, userId, amount, callback) {

    client.query('UPDATE users SET balance_satoshis = balance_satoshis + $1 WHERE id = $2', [amount, userId], function(err, res) {
        if (err) return callback(err);
        assert(res.rowCount === 1);
        callback(null);
    });
}

exports.getUserPlays = function(userId, limit, offset, callback) {
    assert(userId);

    query('SELECT p.bet, p.bonus, p.cash_out, p.created, p.game_id, g.game_crash FROM plays p ' +
        'LEFT JOIN (SELECT * FROM games) g ON g.id = p.game_id ' +
        'WHERE p.user_id = $1 AND g.ended = true ORDER BY p.id DESC LIMIT $2 OFFSET $3',
        [userId, limit, offset], function(err, result) {
            if (err) return callback(err);
            callback(null, result.rows);
        }
    );
};

exports.getGiveAwaysAmount = function(userId, callback) {
    assert(userId);
    query('SELECT SUM(g.amount) FROM giveaways g where user_id = $1', [userId], function(err,result) {
        if (err) return callback(err);
        return callback(null, result.rows[0]);
    });
};

exports.addGiveaway = function(userId, callback) {
    assert(userId && callback);
    getClient(function(client, callback) {

            client.query('SELECT last_giveaway FROM users_view WHERE id = $1', [userId] , function(err, result) {
                if (err) return callback(err);

                if (!result.rows) return callback('USER_DOES_NOT_EXIST');
                assert(result.rows.length === 1);
                var lastGiveaway = result.rows[0].last_giveaway;
                var eligible = lib.isEligibleForGiveAway(lastGiveaway);

                if (typeof eligible === 'number') {
                    return callback({ message: 'NOT_ELIGIBLE', time: eligible});
                }

                var amount = 200; // 2 bits
                client.query('INSERT INTO giveaways(user_id, amount) VALUES($1, $2) ', [userId, amount], function(err) {
                    if (err) return callback(err);

                    addSatoshis(client, userId, amount, function(err) {
                        if (err) return callback(err);

                        callback(null);
                    });
                });
            });

        }, callback
    );
};

exports.addRawGiveaway = function(userNames, amount, callback) {
    assert(userNames && amount && callback);

    getClient(function(client, callback) {

        var tasks = userNames.map(function(username) {
            return function(callback) {

                client.query('SELECT id FROM users WHERE lower(username) = lower($1)', [username], function(err, result) {
                    if (err) return callback('unable to add bits');

                    if (result.rows.length === 0) return callback(username + ' didnt exists');

                    var userId = result.rows[0].id;
                    client.query('INSERT INTO giveaways(user_id, amount) VALUES($1, $2) ', [userId, amount], function(err, result) {
                        if (err) return callback(err);

                        assert(result.rowCount == 1);
                        addSatoshis(client, userId, amount, function(err) {
                            if (err) return callback(err);
                            callback(null);
                        });
                    });
                });
            };
        });

        async.series(tasks, function(err, ret) {
            if (err) return callback(err);
            return callback(null, ret);
        });

    }, callback);
};

exports.getUserNetProfit = function(userId, callback) {
    assert(userId);
    query('SELECT (' +
            'COALESCE(SUM(cash_out), 0) + ' +
            'COALESCE(SUM(bonus), 0) - ' +
            'COALESCE(SUM(bet), 0)) profit ' +
        'FROM plays ' +
        'WHERE user_id = $1', [userId], function(err, result) {
            if (err) return callback(err);
            assert(result.rows.length == 1);
            return callback(null, result.rows[0]);
        }
    );
};

exports.getUserNetProfitLast = function(userId, last, callback) {
    assert(userId);
    query('SELECT (' +
            'COALESCE(SUM(cash_out), 0) + ' +
            'COALESCE(SUM(bonus), 0) - ' +
            'COALESCE(SUM(bet), 0))::bigint profit ' +
            'FROM ( ' +
                'SELECT * FROM plays ' +
                'WHERE user_id = $1 ' +
                'ORDER BY id DESC ' +
                'LIMIT $2 ' +
            ') restricted ', [userId, last], function(err, result) {
            if (err) return callback(err);
            assert(result.rows.length == 1);
            return callback(null, result.rows[0].profit);
        }
    );
};

exports.getPublicStats = function(username, callback) {

  var sql = 'SELECT id AS user_id, username, gross_profit, net_profit, games_played, ' +
            'COALESCE((SELECT rank FROM leaderboard WHERE user_id = id), -1) rank ' +
            'FROM users WHERE lower(username) = lower($1)';

    query(sql,
        [username], function(err, result) {
            if (err) return callback(err);

            if (result.rows.length !== 1)
                return callback('USER_DOES_NOT_EXIST');

            return callback(null, result.rows[0]);
        }
    );
};

exports.makeWithdrawal = function(userId, satoshis, withdrawalAddress, withdrawalId, callback) {
    assert(typeof userId === 'number');
    assert(typeof satoshis === 'number');
    assert(typeof withdrawalAddress === 'string');
    assert(satoshis > 10000);
    assert(lib.isUUIDv4(withdrawalId));

    getClient(function(client, callback) {

        client.query("UPDATE users SET balance_satoshis = balance_satoshis - $1 WHERE id = $2",
            [satoshis, userId], function(err, response) {
            if (err) return callback(err);

            if (response.rowCount !== 1)
                return callback(new Error('Unexpected withdrawal row count: \n' + response));

            client.query('INSERT INTO fundings(user_id, amount, bitcoin_withdrawal_address, withdrawal_id) ' +
                "VALUES($1, $2, $3, $4) RETURNING id",
                [userId, -1 * satoshis, withdrawalAddress, withdrawalId],
                function(err, response) {
                    if (err) return callback(err);

                    var fundingId = response.rows[0].id;
                    assert(typeof fundingId === 'number');

                    callback(null, fundingId);
                }
            );
        });

    }, callback);
};

exports.getWithdrawals = function(userId, callback) {
    assert(userId && callback);

    query("SELECT * FROM fundings WHERE user_id = $1 AND amount < 0 ORDER BY created DESC", [userId], function(err, result) {
        if (err) return callback(err);

        var data = result.rows.map(function(row) {
           return {
               amount: Math.abs(row.amount),
               destination: row.bitcoin_withdrawal_address,
               status: row.bitcoin_withdrawal_txid,
               created: row.created
           };
        });
        callback(null, data);
    });
};

exports.getDeposits = function(userId, callback) {
    assert(userId && callback);

    query("SELECT * FROM fundings WHERE user_id = $1 AND amount > 0 ORDER BY created DESC", [userId], function(err, result) {
        if (err) return callback(err);

        var data = result.rows.map(function(row) {
            return {
                amount: row.amount,
                txid: row.bitcoin_deposit_txid,
                created: row.created
            };
        });
        callback(null, data);
    });
};

exports.getDepositsAmount = function(userId, callback) {
    assert(userId);
    query('SELECT SUM(f.amount) FROM fundings f WHERE user_id = $1 AND amount >= 0', [userId], function(err, result) {
        if (err) return callback(err);
        callback(null, result.rows[0]);
    });
};

exports.getWithdrawalsAmount = function(userId, callback) {
    assert(userId);
    query('SELECT SUM(f.amount) FROM fundings f WHERE user_id = $1 AND amount < 0', [userId], function(err, result) {
        if (err) return callback(err);

        callback(null, result.rows[0]);
    });
};

exports.setFundingsWithdrawalTxid = function(fundingId, txid, callback) {
    assert(typeof fundingId === 'number');
    assert(typeof txid === 'string');
    assert(callback);

    query('UPDATE fundings SET bitcoin_withdrawal_txid = $1 WHERE id = $2', [txid, fundingId],
        function(err, result) {
           if (err) return callback(err);

            assert(result.rowCount === 1);

            callback(null);
        }
    );
};


exports.getLeaderBoard = function(byDb, order, callback) {
    var sql = 'SELECT * FROM leaderboard ORDER BY ' + byDb + ' ' + order + ' LIMIT 100';
    query(sql, function(err, data) {
        if (err)
            return callback(err);
        callback(null, data.rows);
    });
};

exports.addChatMessage = function(userId, created, message, channelName, isBot, callback) {
    var sql = 'INSERT INTO chat_messages (user_id, created, message, channel, is_bot) values($1, $2, $3, $4, $5)';
    query(sql, [userId, created, message, channelName, isBot], function(err, res) {
        if(err)
            return callback(err);

        assert(res.rowCount === 1);

        callback(null);
    });
};

exports.getChatTable = function(limit, channelName, callback) {
    assert(typeof limit === 'number');
    var sql = "SELECT chat_messages.created AS date, 'say' AS type, users.username, users.userclass AS role, chat_messages.message, is_bot AS bot " +
        "FROM chat_messages JOIN users ON users.id = chat_messages.user_id WHERE channel = $1 ORDER BY chat_messages.id DESC LIMIT $2";
    query(sql, [channelName, limit], function(err, data) {
        if(err)
            return callback(err);
        callback(null, data.rows);
    });
};

//Get the history of the chat of all channels except the mods channel
exports.getAllChatTable = function(limit, callback) {
    assert(typeof limit === 'number');
    var sql = m(function(){/*
     SELECT chat_messages.created AS date, 'say' AS type, users.username, users.userclass AS role, chat_messages.message, is_bot AS bot, chat_messages.channel AS "channelName"
     FROM chat_messages JOIN users ON users.id = chat_messages.user_id WHERE channel <> 'moderators'  ORDER BY chat_messages.id DESC LIMIT $1
    */});
    query(sql, [limit], function(err, data) {
        if(err)
            return callback(err);
        callback(null, data.rows);
    });
};

exports.getSiteStats = function(callback) {

    function as(name, callback) {
        return function(err, results) {
            if (err)
                return callback(err);

            assert(results.rows.length === 1);
            callback(null, [name, results.rows[0]]);
        }
    }

    var tasks = [
        function(callback) {
            query('SELECT COUNT(*) FROM users', as('users', callback));
        },
        function (callback) {
            query('SELECT COUNT(*) FROM games', as('games', callback));
        },
        function(callback) {
            query('SELECT COALESCE(SUM(fundings.amount), 0)::bigint sum FROM fundings WHERE amount < 0', as('withdrawals', callback));
        },
        function(callback) {
            query("SELECT COUNT(*) FROM games WHERE ended = false AND created < NOW() - interval '5 minutes'", as('unterminated_games', callback));
        },
        function(callback) {
            query('SELECT COUNT(*) FROM fundings WHERE amount < 0 AND bitcoin_withdrawal_txid IS NULL', as('pending_withdrawals', callback));
        },
        function(callback) {
            query('SELECT COALESCE(SUM(fundings.amount), 0)::bigint sum FROM fundings WHERE amount > 0', as('deposits', callback));
        },
        function(callback) {
            query('SELECT ' +
                'COUNT(*) count, ' +
                'SUM(plays.bet)::bigint total_bet, ' +
                'SUM(plays.cash_out)::bigint cashed_out, ' +
                'SUM(plays.bonus)::bigint bonused ' +
                'FROM plays', as('plays', callback));
        }
    ];

    async.series(tasks, function(err, results) {
       if (err) return callback(err);

       var data = {};

        results.forEach(function(entry) {
           data[entry[0]] = entry[1];
        });

        callback(null, data);
    });

};