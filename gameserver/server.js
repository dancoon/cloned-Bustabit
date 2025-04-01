var async = require('async');
var assert = require('assert');
var constants = require('constants');
var fs = require('fs');
var path = require('path');

var config = require('./server/config');
var socket = require('./server/socket');
var database = require('./server/database');
var Game = require('./server/game');
var Chat = require('./server/chat');
var GameHistory = require('./server/game_history');

var _ = require('lodash');

var server;

if (config.USE_HTTPS) {
    var options = {
        key: fs.readFileSync(config.HTTPS_KEY),
        cert: fs.readFileSync(config.HTTPS_CERT),
        secureProtocol: 'SSLv23_method',
        secureOptions: constants.SSL_OP_NO_SSLv3 | constants.SSL_OP_NO_SSLv2
    };

    if (config.HTTPS_CA) {
        options.ca = fs.readFileSync(config.HTTPS_CA);
    }

    server = require('https').createServer(options).listen(config.PORT, function() {
        console.log('Listening on port ', config.PORT, ' on HTTPS!');
    });
} else {
    server = require('http').createServer().listen(config.PORT, function() {
        console.log('Listening on port ', config.PORT, ' with http');
    });
}

// Initialize game server
async function initializeGameServer() {
    try {
        // Get last game info
        const lastGameInfo = await database.getLastGameInfo();
        console.log('Last game info:', lastGameInfo);

        // Get game history and bankroll in parallel
        const [gameHistory, bankroll] = await Promise.all([
            database.getGameHistory(),
            database.getBankroll()
        ]);

        console.log('Have a bankroll of: ', bankroll/1e8, ' btc');

        const lastGameId = lastGameInfo.id;
        const lastHash = lastGameInfo.hash;
        assert(typeof lastGameId === 'number');

        const gameHistoryInstance = new GameHistory(gameHistory);
        const game = new Game(lastGameId, lastHash, bankroll, gameHistoryInstance);
        const chat = new Chat();

        socket(server, game, chat);
    } catch (err) {
        console.error('[INTERNAL_ERROR] Failed to initialize game server:', err);
        throw err;
    }
}

// Start the game server
initializeGameServer().catch(err => {
    console.error('Failed to start game server:', err);
    process.exit(1);
});
