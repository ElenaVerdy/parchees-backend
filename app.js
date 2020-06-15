const express = require('express');
const app = express();
const server = app.listen(process.env.PORT || 8080, () => console.log(`Listening on port ${process.env.PORT || 8080}!`));
const io = require("socket.io")(server);
const cloneDeep = require('lodash.clonedeep');

app.use(express.static(__dirname + '/public'));

app.use(function(req, res, next) { 
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Origins", process.env.PORT ? 'https://parchees-82bf1.web.app/' : 'http://192.168.1.67:3000/');
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

//io.set('origins', process.env.PORT ? 'https://parchees-82bf1.web.app/' : 'http://192.168.1.67:3000/');

app.get("/test", (req, res)=>{
    res.end("test indeed")
})

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
    
    socket.on("get-tables-request", () => {
        let availableTables = tables.filter(i => {
            return i.players.length !== 4 && (!i.game || i.game.finished);
        })
        .map(table => {return {tableId: table.id, players: table.players}});
        socket.emit("update-tables", availableTables);
    })

    socket.on("new-table", data => {
        let tableId = "t_" + (Math.random() * 100000000 ^ 0);
        let player = {
            id: socket.id, 
            ready: false, 
            name: "Игрок", 
            picture: "https://static-s.aa-cdn.net/img/ios/846073598/46f520ebc3d526b7b251d87af200ca03?v=1",
            rank: 2100
        };

        tables.push({id: tableId, players: [player]});

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
            name: "Игрок",
            rank: 2100,
            picture: "https://static-s.aa-cdn.net/img/ios/846073598/46f520ebc3d526b7b251d87af200ca03?v=1"});
        socket.emit("connect-to", {id: table.id, players: table.players, tableId: table.id});
        socket.join(table.id);
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

    socket.on("roll-dice", (data) => {
        let table = tables.findById(data.tableId);
        if (!table || !table.game) {
            socket.emit("dice-rolled", {error: "404: Игра не найдена."});
            return;
        }

        let player = tables.findPlayer(data.tableId, socket.id);
        if (!player) {
            socket.emit("dice-rolled", {error: "Игрок не участвует в игре!"})
            return;
        }

        if (tables.indexOfGamePlayer(table.id, socket.id) !== table.game.turn) {
            socket.emit("dice-rolled", {error: "Не ваш ход!"});
            return;
        }
        
        if (table.game.diceRolled && !table.game.doublesStreak) {
            socket.emit("dice-rolled", {error: "Кубики уже брошены!"});
            return;
        }

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

        io.in(data.tableId).emit("dice-rolled", {dice});
    });

    socket.on("finish-turn", data => nextTurn(data.tableId, socket.id));
    
    socket.on("ready", (data) => {
        
        let table = tables.findById(data.tableId);
        if (!table) return;
        
        let player = tables.findPlayer(data.tableId, socket.id);
        if (!player) return;
        
        player.ready = data.ready;
        io.in(table.id).emit("update-players", {players: table.players});
        
        updateCountDown(table.id);
    })

    socket.on("chip-moved", data => {

        let table = tables.findById(data.tableId);
        if (!table) {
            socket.emit("player-made-move", {error: "game not found"})
            return;
        }
        let player = tables.findPlayer(data.tableId, socket.id);
        if (!player) {
            socket.emit("player-made-move", {error: "You are not in the game"})
            return;
        }
        if (data.yourTurn !== table.game.turn) {
            socket.emit("player-made-move", {error: "not your turn"})
            return;
        }

        if (!table.game.dice[data.diceNum]) {
            socket.emit("player-made-move", {error: "this dice already used"})
            return;
        }
        
        let route = getRoute(table, data.diceNum, data.chipNum, data.targetId);
        if (route) {
            moveChipOnRoute(table, table.game.chips[table.game.playersOrder[data.yourTurn]][data.chipNum], route, data.diceNum)
        }
    })
})

function nextTurn(tableId, socketId) {
    let table = tables.findById(tableId);
    if (!table || !table.game) return;
    
    let gamePlayerIndex = tables.indexOfGamePlayer(tableId, socketId);
    let gamePlayer = table.game.players[gamePlayerIndex];
    
    if (!gamePlayer) return;
    if (gamePlayerIndex !== table.game.turn) return;


    if (!table.game.diceRolled && !table.game.players[gamePlayerIndex].left && table.game.players[gamePlayerIndex].missedLastTurn) {
        playerDisconnected(table, socketId);
        io.to(socketId).emit('removed');
    }

    if (!table.game.diceRolled && !table.game.players[gamePlayerIndex].left) {
        table.game.players[gamePlayerIndex].missedLastTurn = true;
    }

    table.game.dice = [];
    table.game.turn = findNextTurn(table);
    table.game.diceRolled = false;

    io.in(table.id).emit("next-turn", {turn: table.game.turn});
}

function moveChipOnRoute(table, chip, route, diceNum) {
    table.game.dice[diceNum] = undefined;
    
    io.in(table.id).emit("player-made-move", {playerNum: chip.player, num: chip.num, position: route[route.length - 1], diceNum});
    
    for (let i = 0; i < route.length; i++) {
        moveChipToCell(table, chip, route[i], diceNum);  
        if (i === route.length - 1) {
            if (checkForWin(table, chip.player)) {
                gameWon(table, chip.player);
            }
        }      
    }

}
function gameWon(table, playerNum) {
    let results = table.players.map((pl, i) => { 
        return {
            id: pl.id, 
            name: pl.name, 
            rank: pl.rank, 
            deltaRank: (table.game.playersOrder[i] === playerNum ? 20 : -10),
            isWinner: (table.game.playersOrder[i] === playerNum)
        }
    })

    table.game.finished = true;

    io.in(table.id).emit("player-won", {results});
    io.in(table.id).emit('update-players', {players: table.players})
}
function moveChipToCell(table, chip, destination, diceNum, toBase = false) {
    let scheme = table.game.scheme;

    scheme[chip.position].chip = null;

    chip.position = destination;
    chip.isAtBase = toBase;

    if (scheme[destination].chip) {
        let eatenChipPlayer = scheme[destination].chip[16];
        let eatenChipNum = scheme[destination].chip[21];

        moveChipToCell(table, table.game.chips[eatenChipPlayer][eatenChipNum], `game_chip-base_chip-space_player${eatenChipPlayer}_num${eatenChipNum}`, null, true);
        setTimeout(() => {
            io.in(table.id).emit("player-made-move", {
                playerNum: eatenChipPlayer, 
                num: eatenChipNum, 
                position: `game_chip-base_chip-space_player${eatenChipPlayer}_num${eatenChipNum}`,
                diceNum
            });
        }, 100)
    }

    scheme[destination].chip = chip.id;
}

function getRoute(table, diceNum, chipNum, cellId) {
    
    let scheme = table.game.scheme;
    let result = [];

    let dice = table.game.dice[diceNum];
    let currentPlayer = table.game.playersOrder[table.game.turn];
    let chip = table.game.chips[currentPlayer][chipNum];
    let chipCell = scheme[chip.position];
    
    if (dice === 1 && chipCell.links.for1 && chipCell.links.for1 === cellId && getPlayerFromCell(table, cellId) !== currentPlayer) {
        return [chipCell.links.for1];
    }
    
    if (dice === 3 && chipCell.links.for3 && chipCell.links.for3 === cellId && getPlayerFromCell(table, cellId) !== currentPlayer) {
        return [chipCell.links.for3];
    }
    
    if (dice === 6 && chipCell.links.for6 && chipCell.links.for6 === cellId && !table.game.scheme[cellId].chip) {
        return [chipCell.links.for6];
    }
    
    let route = [];
    
    if (!chip.isAtBase) {
        let current = chipCell;
        let canMove = true;
        
        if (current.isSH) {
            if (scheme[current.links.outOfSH].chip) {
                return false;
            } else {
                route.push(current.links.outOfSH);
                current = scheme[current.links.outOfSH];
            } 
        }

        for (let i = 1; i <= dice; i++) {
            
            current = scheme[(current.links["toFinish" + currentPlayer]) || current.links.next];
            if (!current) {
                return false;
            }

            route.push(current.id)
            
            if (current.chip && i !== dice) {
                return false;
                
            } else if (current.chip && i === dice) {
                
                if (getPlayerFromCell(current.id) === currentPlayer)
                    return false;
            }
        }
        
        if (canMove) {

            if (current.id === cellId) {
                result = route;
            }
            
            if (current.links.end && current.links.end === cellId) {
                route.push(current.links.end);
                result = route;
            }
            
            if (current.links.toSH && current.links.toSH === cellId) {
                route.push(current.links.toSH);
                result = route;
            }

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
    delete timers[table.id];
    io.in(table.id).emit("all-players-ready", {cancel: true}); 
    
    
    if (!turnOff) {
        io.in(table.id).emit("all-players-ready", {cancel: false}); 
        timers[table.id] = setTimeout(() => {
            table.game = newGame(table.players);
            table.players.forEach(pl => pl.ready = false);
            io.in(table.id).emit("game-start", {turn: table.game.turn, players: table.players});
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
        moveChipToCell(table, table.game.chips[playerNum][chipNum], `game_chip-base_chip-space_player${playerNum}_num${chipNum}`, null, true);
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
                    id: `game_cell-finish_player${n}_${k}`
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
                id:("game_start-cell_player" + n)
            };
            start.links = { next: id };

            ret[start.id] = start;

            [1, 2, 3, 4].forEach(k => {
                let baseId = `game_chip-base_chip-space_player${n}_num${k}`;
                let base = { id: baseId };
                base.isBase = true;
                base.links = {for6: start.id}
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
                id:("game_cell-safe-house" + ((i - 10) / 12))
            };
            sh.links = { outOfSH: id };

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
        doublesStreak: 0
    };

    ret.players.forEach((pl, i) => {
        pl.missedLastTurn = false;
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

    let chipId = table.game.scheme[cellId].chip;

    if (chipId && chipId[16])
        return +chipId[16];
    else 
        return null;
}

function checkForWin(table, playerNum) {
    let scheme = table.game.scheme;
    for (let i = 1; i < 5; i++) {
        if (!scheme[`game_cell-finish_player${playerNum}_${i}`].chip)
            return false;
    }
    return true;
}
