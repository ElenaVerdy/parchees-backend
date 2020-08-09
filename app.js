const express       = require('express');
const censor        = require('./censor.js');
const app           = express();
const server        = app.listen(process.env.PORT || 8000, () => console.log(`Listening on port ${process.env.PORT || 8000}!`));
const { Pool }      = require('pg');
const io            = require("socket.io")(server);
const cloneDeep     = require('lodash.clonedeep');
const commonChat    = [];
app.use(express.static(__dirname + '/public'));

app.use(function(req, res, next) { 
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Origins", process.env.PORT ? 'https://parchees-82bf1.web.app/' : 'http://192.168.1.67:3000/');
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});
//io.set('origins', 'https://parchees-82bf1.web.app/');
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/parcheesi"
});

const tables = [];
tables.remove = function(tableId) {
    let table = this.find(table => table.id === tableId);

    if (!table)
        return false;

    tables.splice(tables.indexOf(table), 1);

    return true;
}
tables.findById = function(id) {return this.find(table => table.id === id)}
tables.removePlayer = function(tableId, socketId) {
    let table = this.findById(tableId);

    if (!table)
        return false;

    let player = table.players.find(player => player.id === socketId);

    if (!player)
        return false;

    table.players.splice(table.players.indexOf(player), 1);

    return true;
}
tables.findPlayer = function(tableId, socketId) {
    let table = this.findById(tableId);

    if (!table)
        return false;
    
    let player = table.players.find(player => player.id === socketId);

    return player || false;
}
tables.indexOfGamePlayer = function(tableId, socketId) {
    let table = this.findById(tableId);
    
    if (!table || !table.game)
        return -1;

    let player = table.game.players.find(player => player.id === socketId);
    
    if (!player)
        return -1;

    return table.game.players.indexOf(player);
}

const timers = {};

io.on("connection", socket => {
    socket.on("init", data => {
        socket.userinfo = data;
        data.name = `${data.last_name} ${data.first_name}`;
        pool
        .query(`SELECT * FROM users WHERE id = ${data.id} limit 1;`)
        .then(res => {
            if (res.rows.length) {
                socket.emit("init-finished", { ...res.rows[0], name: data.name});
            } else {
                pool.query(`INSERT INTO users (id) values (${data.id});`)
                .then(data => {
                    pool
                    .query(`SELECT * FROM users WHERE id = ${data.id} limit 1;`)
                    .then(res => socket.emit("init-finished", {...res.rows[0], name: data.name, new: true}))
                    .catch(err => console.log(err));
                })
                .catch(err => console.log(err))
            }
        })
        .catch(err => console.error('Error executing query', err.stack));
    });
    socket.on("get-tables-request", () => {
        let availableTables = tables.filter(i => {
            return i.players.length !== 4 && (!i.game || i.game.finished);
        })
        .map(table => {return {tableId: table.id, players: table.players}});
        socket.emit("update-tables", availableTables);
    });

    socket.on("new-table", data => {
        let tableId = "t_" + (Math.random() * 100000000 ^ 0);
        let player = {
            id: socket.id,
            ready: false, 
            name: data.name,
            photo_50: data.photo_50,
            photo_100: data.photo_100,
            rating: data.rating
        };

        tables.push({id: tableId, players: [player], chat: []});

        socket.emit("connect-to", {id: tableId, players: [player]});
        socket.join(tableId);
        io.in(tableId).emit("update-players", {players: [player], tableId})
    })

    socket.on("connect-to-request", data => {
        let table = tables.findById(data.id);

        if (!table || (table.game && !table.game.finished) || table.players.length === 4) {
            socket.emit("cant-join", {text: "Не получилось подключиться!"});
            return;
        }

        table.players.push({
            id: socket.id,
            ready: false,
            name: data.name,
            photo_50: data.photo_50,
            photo_100: data.photo_100,
            rating: data.rating
        });
        socket.emit("connect-to", {id: table.id, players: table.players, tableId: table.id});
        socket.join(table.id);
        socket.emit("new-msg", { room: data.id, old: table.chat });
        io.in(table.id).emit("update-players", {players: table.players});
        
        updateCountDown(table.id)
    })

    socket.on("disconnecting", (data) => {

        let rooms = Object.keys(socket.rooms);

        rooms.forEach( room =>{
            if (room.slice(0, 2) !== "t_") return;

            let table = tables.findById(room);
            if (!table) return;

            playerDisconnected(table, socket.id)
        })
    });

    socket.on("roll-dice", rollDice.bind(socket));

    socket.on("finish-turn", data => nextTurn.call(socket, data.tableId));
    
    socket.on("ready", (data) => {
        let table = tables.findById(data.tableId);
        if (!table) return;

        let player = tables.findPlayer(data.tableId, socket.id);
        if (!player) return;

        player.ready = data.ready;
        io.in(table.id).emit("update-players", {players: table.players});

        updateCountDown(table.id);
    });

    socket.on("chip-moved", playerMadeMove.bind(socket));
    socket.on("reset-timer", data => {
        let table = tables.findById(data.tableId);
        if (!table) {
            socket.emit("err", {error: "game not found"});
            return;
        }
        let player = tables.findPlayer(data.tableId, socket.id);
        if (!player) {
            socket.emit("err", {error: "You are not in the game"});
            return;
        }
        if (data.turn !== table.game.turn) {
            socket.emit("err", {error: "not your turn"});
            return;
        }
        clearTimeout(timers[table.id]);
        timers[table.id] = setTimeout(autoMove.bind(null, table), 10000);
    });
    socket.on("send-msg", data => {
        let chat;

        if (data.room === 'main') {
            chat = commonChat;
        } else {
            let table = tables.findById(data.room);
            if (!table) return;
            if (!table.players.find(pl => socket.id === pl.id)) return;

            chat = table.chat;
        }
        data.text = censor(data.text);
        chat.unshift({player: data.player, text: data.text});
        if (data.room === 'main') {
            io.emit("new-msg", data)
        } else {
            io.in(data.room).emit("new-msg", data);
        }

        if (chat.length > 20) chat.splice(20);
    });
    socket.on("get-common-msgs", () => {socket.emit("new-msg", { room: 'main', old: commonChat })} );
})

function playerMadeMove(data) {
    let table = tables.findById(data.tableId);
    if (!table) {
        this.emit("player-made-move", {error: "game not found"});
        return;
    }
    let player = tables.findPlayer(data.tableId, this.id);
    if (!player) {
        this.emit("player-made-move", {error: "You are not in the game"});
        return;
    }
    if (data.yourTurn !== table.game.turn) {
        this.emit("player-made-move", {error: "not your turn"});
        return;
    }

    if (!table.game.dice[data.diceNum]) {
        this.emit("player-made-move", {error: "this dice already used"});
        return;
    }

    let route = getRoute(table, data.diceNum, data.chipNum, data.targetId);
    if (route) {
        moveChipOnRoute(table, table.game.chips[table.game.playersOrder[data.yourTurn]][data.chipNum], route, data.diceNum);
    } else {
        this.emit("player-made-move", {error: "Can't build route"});
    }
}
function autoMove(table) {
    let socket = io.sockets.connected[table.players[table.game.turn].id];
    if (!socket) return;
    if (!table.game.diceRolled) {
        let gamePlayerIndex = tables.indexOfGamePlayer(table.id, socket.id);
        if (!~gamePlayerIndex) return console.log('autoMove: player is not in game');
        if (table.game.players[gamePlayerIndex].missedTurn) {
            return playerDisconnected(table, socket.id);
        } else {
            // table.game.players[gamePlayerIndex].missedTurn = true;
        }
        rollDice.call(socket, {tableId: table.id, dice: []}, true);
    } else {
        if (!table.game.dice[0] && !table.game.dice[1]) {
            if (table.game.doublesStreak)
                rollDice.call(socket, {tableId: table.id, dice: []}, true);
            else
                return nextTurn.call(socket, table.id);
        } else {
            if (!makeRandomMove.call(socket, table)) {
                if (!table.game.doublesStreak)
                    return nextTurn.call(socket, table.id);
            }
        }
    }
    autoMove(table);
}
function makeRandomMove(table) {
    let dice = table.game.dice;
    let possibleMoves = [];
    if (dice[0]) 
        [1, 2, 3, 4].forEach(i => {
            getPossibleMoves(table.game.chips[table.game.playersOrder[table.game.turn]][i], dice[0], table, table.game.scheme).forEach(k => possibleMoves.push({diceNum: '0', chipNum: i, targetId: k}));
        });
    if (dice[1]) 
        [1, 2, 3, 4].forEach(i => {
            getPossibleMoves(table.game.chips[table.game.playersOrder[table.game.turn]][i], dice[1], table, table.game.scheme).forEach(k => possibleMoves.push({diceNum: '1', chipNum: i, targetId: k}));
        });
    if (!possibleMoves.length) {
        table.game.dice[0] = table.game.dice[1] = undefined;
        return false;
    }
    let move = possibleMoves[(Math.random() * possibleMoves.length) ^ 0];

    playerMadeMove.call(this, {tableId: table.id, yourTurn: table.game.turn, chipNum: move.chipNum, targetId: move.targetId, diceNum: move.diceNum});
    return true;
}

function getPossibleMoves(chip, dice, table, scheme) {

    if (!chip || !dice)
        return [];
        
    let chipCell = scheme[chip.position];
    let currentPlayer = table.game.playersOrder[table.game.turn];
    let result = [];

    if (dice === 1 && chipCell.links.for1 && getPlayerFromCell(table, chipCell.links.for1) !== currentPlayer)    
        result.push(chipCell.links.for1);

    if (dice === 3 && chipCell.links.for3 && getPlayerFromCell(table, chipCell.links.for3) !== currentPlayer) 
        result.push(chipCell.links.for3);

    if (dice === 6 && chipCell.links.for6)
        result.push(chipCell.links.for6);

    if (!chip.isAtBase) {
        let current = chipCell;
        let canMove = true;

        if (current.isSH) {
            if (scheme[current.links.outOfSH].chips.length)
                return [];
            else 
                current = scheme[current.links.outOfSH];
        }

        for (let i = 1; i <= dice; i++) {
            let toFinish = scheme[current.links["toFinish" + currentPlayer]];
            if (toFinish && !toFinish.chips.length) {
                for (let k = i + 1; k <= dice; k++) {
                    toFinish = scheme[toFinish.links.next];
                    if (!toFinish || toFinish.chips.length)
                        break;

                    if (k === dice && toFinish) result.push(toFinish.id);
                }
            }
            current = scheme[current.links.next];
            if (!current) {
                canMove = false;
                break;
            }
            if (current.chips.length && i !== dice) {
                canMove = false;
                break;
            } else if (current.chips.length && i === dice) {
                if (getPlayerFromCell(table, current.id) === currentPlayer) {
                    canMove = false;
                    break;
                }
            }
        }

        if (canMove) {
            result.push(current.id);

            if (current.links.end && getPlayerFromCell(table, current.links.end) !== currentPlayer)
                result.push(current.links.end);

            if (current.links.toSH && !scheme[current.links.toSH].chips.length)
                result.push(current.links.toSH);
        }
    }
    
    return result;
}

function nextTurn(tableId, socketId = null) {
    let error, gamePlayerIndex, gamePlayer;
    let table = tables.findById(tableId);
    (function(){
        if (!table || !table.game)
            return error = "404: Игра не найдена.";
        
        gamePlayerIndex = tables.indexOfGamePlayer(tableId, socketId || this.id);
        gamePlayer = table.game.players[gamePlayerIndex];
        
        if (!gamePlayer) return error = "Игрок не участвует в игре!";
        if (gamePlayerIndex !== table.game.turn) return error = "Не ваш ход!";
    }).call(this);

    if (error) return io.to(socketId || this.id).emit("dice-rolled", { error });

    table.game.dice = [];
    table.game.turn = findNextTurn(table);
    table.game.diceRolled = false;
    clearTimeout(timers[tableId]);
    timers[tableId] = setTimeout(autoMove.bind(null, table), 10000);
    table.game.actionCount = table.game.actionCount + 1;
    io.in(table.id).emit("next-turn", {turn: table.game.turn, actionCount: table.game.actionCount});
}

function moveChipOnRoute(table, chip, route, diceNum) {
    table.game.dice[diceNum] = undefined;
    table.game.actionCount = table.game.actionCount + 1;
    io.in(table.id).emit("player-made-move", {playerNum: chip.player, num: chip.num, position: route[route.length - 1], diceNum, actionCount: table.game.actionCount});

    for (let i = 0; i < route.length; i++) {
        moveChipToCell(table, chip, route[i]);  
        if (i === route.length - 1) {
            if (checkForWin(table, chip.player)) {
                gameWon(table, chip.player);
            }
        }      
    }
}
function rollDice(data, auto) {
    let table = tables.findById(data.tableId);
    let error, player;
    (function() {
        if (!table || !table.game)
            return error = "404: Игра не найдена.";

        player = tables.findPlayer(data.tableId, this.id);
        if (!player)
            return error = "Игрок не участвует в игре!";

        if (tables.indexOfGamePlayer(table.id, this.id) !== table.game.turn)
            return error = "Не ваш ход!";

        if (table.game.diceRolled && !table.game.doublesStreak)
            return error = "Кубики уже брошены!";
    }).call(this);

    if (error) return this.emit("dice-rolled", { error });

    let dice = [];
    
    dice[0] = data.dice[0] || Math.ceil(Math.random() * 6);
    dice[1] = data.dice[1] || Math.ceil(Math.random() * 6);
    
    if (dice[0] === dice[1]) {
        table.game.doublesStreak = table.game.doublesStreak === 2 ? 0 : table.game.doublesStreak + 1;
    } else {
        table.game.doublesStreak = 0;
    }

    table.game.dice = dice;
    table.game.diceRolled = true;
    table.game.actionCount = table.game.actionCount + 1;
    io.in(data.tableId).emit("dice-rolled", {dice, actionCount: table.game.actionCount});
    clearTimeout(timers[table.id]);
    timers[table.id] = setTimeout(autoMove.bind(null, table), 30000);
    auto || (table.game.players[table.game.turn].missedTurn = false);
}
function gameWon(table, playerNum) {
    let results = table.players.map((pl, i) => {
        return {
            id: pl.id,
            name: pl.name,
            rating: pl.rating,
            deltaRank: (table.game.playersOrder[i] === playerNum ? 20 : -10),
            isWinner: (table.game.playersOrder[i] === playerNum)
        }
    });

    table.game.finished = true;
    table.game.actionCount = table.game.actionCount + 1;
    clearTimeout(timers[table.id]);
    io.in(table.id).emit("player-won", {results, actionCount: table.actionCount});
    io.in(table.id).emit('update-players', {players: table.players});
}
function moveChipToCell(table, chip, destination, toBase = false) {
    let scheme = table.game.scheme;

    scheme[chip.position].chips.splice(scheme[chip.position].chips.indexOf(chip.id), 1);

    chip.position = destination;
    chip.isAtBase = toBase;

    if (scheme[destination].chips.length && getPlayerFromCell(table, destination) != chip.player) {
        let eatenChipPlayer = scheme[destination].chips[0][16];
        let eatenChipNum = scheme[destination].chips[0][21];

        moveChipToCell(table, table.game.chips[eatenChipPlayer][eatenChipNum], `game_chip-base_chip-space_player${eatenChipPlayer}_num${eatenChipNum}`, true);
    }

    scheme[destination].chips.push(chip.id);
}

function getRoute(table, diceNum, chipNum, cellId) {
    let scheme = table.game.scheme;
    let result = [];

    let dice = table.game.dice[diceNum];
    let currentPlayer = table.game.playersOrder[table.game.turn];
    let chip = table.game.chips[currentPlayer][chipNum];
    let chipCell = scheme[chip.position];
    
    if (dice === 1 && chipCell.links.for1 && chipCell.links.for1 === cellId && getPlayerFromCell(table, cellId) !== currentPlayer)
        return [chipCell.links.for1];

    if (dice === 3 && chipCell.links.for3 && chipCell.links.for3 === cellId && getPlayerFromCell(table, cellId) !== currentPlayer)
        return [chipCell.links.for3];

    if (dice === 6 && chipCell.links.for6 && chipCell.links.for6 === cellId)
        return [chipCell.links.for6];

    let route = [];

    if (!chip.isAtBase) {
        let current = chipCell;
        let canMove = true;
        let toFinish = cellId.indexOf('game_cell-finish') !== -1;

        if (current.isSH) {
            if (scheme[current.links.outOfSH].chips.length) {
                return false;
            } else {
                route.push(current.links.outOfSH);
                current = scheme[current.links.outOfSH];
            } 
        }

        for (let i = 1; i <= dice; i++) {
            if (toFinish)
                current = scheme[(current.links["toFinish" + currentPlayer]) || current.links.next];
            else
                current = scheme[current.links.next];

            if (!current) return false;

            route.push(current.id)
            
            if (current.chips.length && i !== dice)
                return false;
            else if (current.chips.length && i === dice)
                if (getPlayerFromCell(current.id) === currentPlayer)
                    return false;
        }
        
        if (canMove) {
            if (current.links.end && current.links.end === cellId) route.push(current.links.end);
            if (current.links.toSH && current.links.toSH === cellId) route.push(current.links.toSH);
            
            result = route;
        }
    }
    return result;
}

function updateCountDown(tableId) {
    let table = tables.findById(tableId);
    
    if (table.players.length === 1) {
        io.in(table.id).emit("all-players-ready", {cancel: true});
        return;
    }
    
    countDown(table, !table.players.every(pl => pl.ready));
}

function findNextTurn(table) {
    let ret = table.game.turn;
    for (let i = 0; i < 4; i++) {
        ret = ((ret + 1) === table.game.players.length) ? 0 : ret + 1;

        if (!table.game.players[ret].left)
            return ret;
    }
}
  
function countDown(table, turnOff) {
    clearTimeout(timers[table.id]);
    io.in(table.id).emit("all-players-ready", {cancel: true}); 
    
    if (!turnOff) {
        io.in(table.id).emit("all-players-ready", {cancel: false}); 
        timers[table.id] = setTimeout(() => {
            table.game = newGame(table.players);
            table.players.forEach(pl => pl.ready = false);
            io.in(table.id).emit("game-start", {turn: table.game.turn, players: table.players, actionCount: 0});
            timers[table.id] = setTimeout(() => autoMove.call(null, table), 10000);
            moveChipOnRoute(table, table.game.chips[1][1], ['game_cell46'], 'test');
            moveChipOnRoute(table, table.game.chips[1][2], ['game_cell47'], 'test');
            moveChipOnRoute(table, table.game.chips[1][3], ['game_cell48'], 'test');
        }, 5000)
    }
}

function playerDisconnected(table, socketId) {
    const game = table.game;

    if (game) {
        playerLeftTheGame(table, socketId);
        if (table.players.length === 1)
            tables.remove(table.id);

    } else {
        if (table.players.length === 1) {
            tables.remove(table.id);
            io.to(socketId).emit('removed');
        } else {
            tables.removePlayer(table.id, socketId);
            io.in(table.id).emit("update-players", {players: table.players});
            updateCountDown(table.id);
        }
    }
}
function playerLeftTheGame(table, socketId) {
    let gamePlayerIndex = tables.indexOfGamePlayer(table.id, socketId);
    let gamePlayer = table.game.players[gamePlayerIndex];
    let playerNum = table.game.playersOrder[gamePlayerIndex];
    
    gamePlayer.left = true;

    io.in(table.id).emit("update-players", {playerLeftIndex: gamePlayerIndex});

    [1, 2, 3, 4].forEach((chipNum) => {
        moveChipToCell(table, table.game.chips[playerNum][chipNum], `game_chip-base_chip-space_player${playerNum}_num${chipNum}`, true);
    });
    if (table.game.turn === gamePlayerIndex) {
        nextTurn(table.id, socketId);
    }

    let player = tables.findPlayer(table.id, socketId);
    let playerLeftIndex = table.players.indexOf(player);
    table.players.splice(playerLeftIndex, 1);
    
    if (isOnePlayerLeft(table)) {
        gameWon(table, playerNum);
    }
}
function isOnePlayerLeft(table) {
    if (!table.game)
        return;

    return (table.game.players.filter(pl => !pl.left).length === 1);
}

function createScheme() {
    let ret = {};

    for (let i = 1; i <= 48; i++) {
        let k = {};
        let id = "game_cell" + i;
        k.chips = [];
        let links = {};
        links.next = "game_cell" + (i === 48 ? 1 : (i + 1));
        k.links = links;
        k.id = id
        ret[id] = k;        

        if (i % 12 === 0) {
            let n;

            switch (i) {
                case 48:
                    n = 1;
                    break;
                case 12:
                    n = 4;
                    break;
                case 24:
                    n = 3;
                    break;
                case 36:
                    n = 2;
                    break;
                default:
                    break;
            
            }
            k.links["toFinish" + n] = `game_cell-finish_player${n}_1`; 

            [1, 2, 3, 4].forEach(k => {
                
                let finish = {
                    isFinish: true,
                    id: `game_cell-finish_player${n}_${k}`,
                    chips: []
                };
                finish.links = { next: (k === 4 ? null : `game_cell-finish_player${n}_${k + 1}`) };
    
                ret[finish.id] = finish;

            })
        }
        if (i % 12 === 1) {
            let n;

            switch (i) {
                case 1:
                    n = 1;
                    break;
                case 13:
                    n = 4;
                    break;
                case 25:
                    n = 3;
                    break;
                case 37:
                    n = 2;
                    break;
                default:
                    break;
            
            }
            let start = {
                isStart: true,
                id:("game_start-cell_player" + n),
                chips: [],
                links: { next: id }
            };

            ret[start.id] = start;

            [1, 2, 3, 4].forEach(k => {
                let baseId = `game_chip-base_chip-space_player${n}_num${k}`;
                let base = { id: baseId, isBase: true, links: {for6: start.id}, chips: [] };
                ret[baseId] = base;
            })

        }
        if (i % 12 === 2) {
            links.end = "game_cell" + (i + 7);
        }
        if (i % 12 === 6) {
            links.for1 = "game_cell" + (i === 42 ? 6 : i + 12);
            links.for3 = "game_cell" + (i + 24 > 48 ? i - 24 : i + 24);
        }
        if (i % 12 === 10) {
            links.toSH = "game_cell-safe-house" + ((i - 10) / 12);
            let sh = {
                isSH: true,
                chipId: null,
                id: links.toSH,
                links: { outOfSH: id },
                chips: []
            };
            ret[sh.id] = sh;
        }
    }

    return ret;
}

function newGame(players) {
    let ret = {
        id: ("id_" + (Math.random() * 100000000 ^ 0)),
        players: cloneDeep(players),
        playersOrder: getPlayers(players.length),
        dice: [],
        chips: defaultChipsPositions(getPlayers(players.length)),
        turn: (Math.random() * players.length ^ 0),
        scheme: createScheme(),
        doublesStreak: 0,
        actionCount: 0
    };

    ret.players.forEach((pl, i) => {
        pl.missedTurn = false;
        pl.playerNum = ret.playersOrder[i];
    });

    return ret;
}
function defaultChipsPositions(playersOrder) {
    let ret = {};

    playersOrder.forEach(player => {
        ret[player] = [];
        [1, 2, 3, 4].forEach((i) => {
            ret[player][i] = {
                player,
                num: i,
                isAtBase: true, 
                id: `game_chip_player${player}_num${i}`, 
                position: `game_chip-base_chip-space_player${player}_num${i}`
            }
        })
        
    })

    return ret;
}

function getPlayers(num) {
    let playersOrder = [];
    
    switch (num) {

        case 1:
            playersOrder = [1];

            break;
        
        case 2:
            playersOrder = [1, 3];
            break;

        case 3:
            playersOrder = [1, 2, 3];
            break;

        case 4:
            playersOrder = [1, 2, 3, 4];
            break;

        default:
            break;
    }
        
    return playersOrder;
}
function getPlayerFromCell(table, cellId) {
    if (!table.game)
        return null;

    let chipId = table.game.scheme[cellId].chips[0];

    if (chipId && chipId[16])
        return +chipId[16];
    else 
        return null;
}

function checkForWin(table, playerNum) {
    let scheme = table.game.scheme;
    for (let i = 1; i < 5; i++) {
        if (scheme[`game_cell-finish_player${playerNum}_${i}`].chips.length !== 1)
            return false;
    }
    return true;
}
