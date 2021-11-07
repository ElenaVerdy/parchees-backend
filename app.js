const express       = require('express')
const censor        = require('./utils/censor.js')
const TablesList        = require('./classes/TablesList.js')
const app           = express()
const server        = app.listen(process.env.PORT || 8000, () => console.log(`Listening on port ${process.env.PORT || 8000}!`))
const { Pool }      = require('pg')
const io            = require('socket.io')(server)
const cloneDeep     = require('lodash.clonedeep')
const md5           = require('md5')
const commonChat    = []
const cheats        = require('./metadata.json').cheats
const moneyItems    = require('./metadata.json').money
const pgConfig      = require('./pgConfig')
const errText       = 'Произошла ошибка!'
const cheatOn       = 'Данный чит уже активирован. Дождитесь когда действие закончится, и тогда вы сможете наложить его снова.'
const badErrorHandler = e => console.log('error: ', e)
let topByRank       = []
let topByChips      = []

app.use(express.urlencoded({ extended: false }))
app.use(express.json())
app.use(function(req, res, next) {
    res.header('Access-Control-Allow-Credentials', 'true')
    res.header('Access-Control-Allow-Origins', process.env.PORT ? 'https://parchees-82bf1.web.app/' : 'http://192.168.1.3:3000/')
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept')
    next()
})
//io.set('origins', 'https://parchees-82bf1.web.app/');
const pool = new Pool(pgConfig)

updateRecords()
setInterval(updateRecords, 1000 * 60 * 10)

app.post('/vk_payments_api', (req, res) => {
    const sig = req.body.sig

    delete req.body.sig
    const keys = Object.keys(req.body).sort()
    const str = keys.reduce((sum, cur) => sum += `${cur}=${req.body[cur]}`, '') + 'BuyEiIPxGrCpj2ZvoQhi'

    if (sig !== md5(str)) {
        res.send({ error: { error_code: 10, critical: true } })
    } else {
        switch (req.body.notification_type) {
        case 'get_item':
        case 'get_item_test':
            const item = moneyItems.find(i => i.item_id === req.body.item)

            if (!item) {
                res.send(JSON.stringify({ error: { error_code: 20, critical: true } }))
            } else {
                res.send(JSON.stringify({ response: { ...item, expiration: 3600 } }))
            }
            break
        case 'order_status_change':
        case 'order_status_change_test':
            if (req.body.status === 'chargeable') {
                userBought(req.body.user_id, req.body.item_id)
                res.send(JSON.stringify({ response: { order_id: req.body.order_id, app_order_id: 123123123 } }))
            } else {
                res.send({ error: { error_code: 1, critical: true } })
            }
            break
        case 'get_subscription':
        case 'get_subscription_test':
        case 'subscription_status_change':
        case 'subscription_status_change_test':
            res.send(JSON.stringify({ hello: 'hello' }))
        }
    }
})

const tablesList = new TablesList(io)

let playersConnected = 0

const timers = {}

io.on('connection', socket => {
    playersConnected++

    socket.use((packet, next) => {
        if (socket.user || packet[0] === 'init') {
            return next()
        }
        if (typeof packet[1] !== 'object' || !packet[1]) {
            console.error('all payloads have to be objects')
            return
        }
        socket.emit('request-auth')
    })
    socket.on('init', data => {
        data.name = `${data.first_name} ${data.last_name}`
        pool
            .query(`SELECT *, NOW() AS now FROM users WHERE vk_id = ${data.vk_id} limit 1;`)
            .then(res => {
                if (res.rows.length) {
                    const user = res.rows[0]
                    const previousSocketId = user.socket_id

                    if (previousSocketId && previousSocketId !== socket.id && io.sockets.server.eio.clients[previousSocketId]) {
                        socket.emit('err', { text: 'Кажется вы уже в игре! Может быть в другой вкладке?' })
                        return
                    }
                    pool.query(`UPDATE users SET socket_id = '${socket.id}' WHERE vk_id  = ${data.vk_id}`).catch(badErrorHandler)

                    const timeToLottery = getTimeToLottery(user.last_lottery, user.now)

                    socket.user = { ...user, ...data, name: data.name, timeToLottery }
                    socket.emit('init-finished', { ...user, name: data.name, timeToLottery, topByChips, topByRank })
                } else {
                    pool.query(`INSERT INTO users (vk_id, socket_id) values (${data.vk_id}, '${socket.id}') returning *;`)
                        .then(resp => {
                            socket.user = { ...resp.rows[0], ...data, name: data.name, new: true, timeToLottery: 0 }
                            socket.emit('init-finished', { ...resp.rows[0], name: data.name, new: true, timeToLottery: 0, topByChips, topByRank, justInstalled: true })
                        })
                        .catch(badErrorHandler)
                }
            })
            .catch(err => console.error('Error executing query', err.stack))
    })
    socket.on('get-tables-request', () => {
        const playersInGame = tablesList.playersInGame

        socket.emit('update-tables', {
            availableTables: tablesList.availableTables,
            playersInMenu: playersConnected - playersInGame,
            playersInGame
        })
    })

    socket.on('new-table', ({ bet }) => {
        if (!bet) {
            return
        }
        if (bet > socket.user.chips) {
            return socket.emit('err', { text: 'Недостаточно фишек!' })
        }

        const table = tablesList.addTable({ bet })

        table.addPlayer(socket)

        table.updatePlayers()
    })

    socket.on('connect-to-request', data => {
        const table = tablesList.findById(data.id)

        if (!table || !table.isOpen) {
            socket.emit('cant-join', { text: 'Не получилось подключиться!' })
            return
        }
        if (table.bet > socket.user.chips) {
            return socket.emit('err', { text: 'Недостаточно фишек!' })
        }

        table.addPlayer(socket)

        socket.emit('new-msg', { room: data.id, old: table.chat })
        table.updatePlayers()
        updateCountDown(table)
    })

    socket.on('disconnecting', () => {
        playersConnected--
        const rooms = Object.keys(socket.rooms)

        rooms.forEach( room =>{
            if (room.slice(0, 2) !== 't_') {
                return
            }

            const table = tablesList.findById(room)

            if (!table) {
                return
            }

            playerDisconnected(table, socket.id)
        })
    })

    socket.on('roll-dice', rollDice.bind(socket))

    socket.on('finish-turn', data => nextTurn.call(socket, data.tableId))

    socket.on('leave-table', ({ tableId }) => {
        const table = tablesList.findById(tableId)

        if (!table) {
            return
        }
        const player = table.findPlayer(socket.id)

        if (!player || player.left) {
            return
        }

        socket.leave(tableId)
        playerDisconnected(table, socket.id)
    })

    socket.on('ready', ({ tableId, ready }) => {
        const table = tablesList.findById(tableId)

        if (!table) {
            return
        }

        const player = table.findPlayer(socket.id)

        if (!player) {
            return
        }

        player.ready = ready
        table.updatePlayers()

        updateCountDown(table)
    })

    socket.on('chip-moved', playerMadeMove.bind(socket))
    socket.on('reset-timer', ({ tableId, turn }) => {
        const table = tablesList.findById(tableId)

        if (!table) {
            return badErrorHandler('game not found')
        }
        if (!table.game || !table.game.finished) {
            return badErrorHandler('game is not on')
        }
        const player = table.findPlayer(socket.id)

        if (!player) {
            return badErrorHandler('You are not in the game')
        }
        if (turn !== table.game.turn) {
            return badErrorHandler('not your turn')
        }

        clearTimeout(timers[table.id])
        timers[table.id] = setTimeout(autoMove.bind(null, table), 15000)
    })
    socket.on('send-msg', data => {
        let chat

        if (data.room === 'main') {
            chat = commonChat
        } else {
            const table = tablesList.findById(data.room)

            if (!table) {
                return
            }
            if (!table.players.find(pl => socket.id === pl.id)) {
                return
            }

            chat = table.chat
        }
        data.text = censor(data.text)
        data.vk_id = socket.user.vk_id
        chat.unshift({ player: data.player, text: data.text, vk_id: socket.user.vk_id })
        if (data.room === 'main') {
            io.emit('new-msg', data)
        } else {
            io.in(data.room).emit('new-msg', data)
        }

        if (chat.length > 20) {
            chat.splice(20)
        }
    })
    socket.on('get-common-msgs', () => {
        socket.emit('new-msg', { room: 'main', old: commonChat })
    } )
    socket.on('buy-item', handleBuying.bind(socket))
    socket.on('use-item', data => {
        const { tableId, buy, cheatId } = data
        const table = tablesList.findById(tableId)
        const cheat = cheats.find(ch => ch.id === cheatId)

        if (!cheat || !table || (!buy && !socket.user[cheatId])) {
            return badErrorHandler('bad request')
        }
        const index = table.indexOfPlayer(socket.id)

        if (index === -1) {
            return badErrorHandler('You are not in the game')
        }
        if (index !== table.game.turn) {
            return badErrorHandler('not your turn')
        }

        if (!validateCheat(table, socket, { tableId, buy, cheatId })) {
            return
        }

        const column = buy ? cheat.currency : cheat.id

        pool.query(`UPDATE users SET ${column} = ${column} - ${buy ? cheat.price : 1} WHERE vk_id = ${socket.user.vk_id} returning ${column};`)
            .then(res => {
                if (!res.rows.length) {
                    return socket.emit('err', { text: errText + '123' })
                }
                socket.user[column] = res.rows[0][column]
                useItem(socket, table, { tableId, buy, cheatId })
            })
            .catch((e) => {
                badErrorHandler(e); socket.emit('err', { text: errText })
            })
    })
    socket.on('get-lottery-field', () => {
        let ret

        if (socket.user.lotteryField) {
            ret = socket.user.lotteryField
        } else {
            const simple = [100, 100, 100, 100, 200, 200, 200, 300, 300, 400, 500, 1000, 1500, 2000, 2500].sort(() => Math.random() - 0.5)
            let doubles = [Math.random() * 8 ^ 0, Math.random() * 8 ^ 0, Math.random() * 8 ^ 0, Math.random() * 8 ^ 0, Math.random() * 8 ^ 0, Math.random() * 8 ^ 0]

            doubles = doubles.map(num => cheats[num].id)
            ret = doubles.map((item, i) => simple.splice(0, i).concat(item))
            socket.user.lotteryField = ret
        }
        socket.emit('lottery-field', { field: ret })
    })
    socket.on('lottery-roll', ({ buy }) => {
        if (!socket.user.lotteryField) {
            return socket.emit('err', { text: errText })
        }

        const dice = [Math.random() * 6 + 1 ^ 0, Math.random() * 6 + 1 ^ 0]

        if (dice[0] < dice[1]) {
            dice.push(dice.shift())
        }

        if (!buy && (new Date() - new Date(socket.user.last_lottery) - 1000 * 20) < 0) {
            return socket.emit('err', { text: 'Кажется время еще не пришло!' })
        }
        const prize = socket.user.lotteryField[dice[0] - 1][dice[1] - 1]
        const prizes = { [+prize ? 'chips' : prize]: +prize ? prize + 500 : 1 };

        +prize || (prizes.chips = 500)

        pool.query(`UPDATE users SET ${buy ? 'money = money - 1,' : 'last_lottery = NOW(),'} ${Object.keys(prizes).map(k => `${k} = ${k} + ${prizes[k]}`)} where vk_id = ${socket.user.vk_id} returning *, NOW() AS now;;`)
            .then(res => {
                if (!res.rows.length) {
                    return socket.emit('err', { text: errText })
                }
                const timeToLottery = getTimeToLottery(res.rows[0].last_lottery, res.rows[0].now)

                socket.user = { ...socket.user, ...res.rows[0], timeToLottery }
                socket.emit('update-user-info', socket.user)
                socket.emit('lottery-rolled', { dice })
            })
            .catch((e) => {
                badErrorHandler(e); socket.emit('err', { text: errText })
            })
    })
})

function getTimeToLottery(last, now) {
    const msGap = 1000 * 60 * 60 * 24
    const ret = (new Date(now) - new Date(last) - msGap)

    return ret > 0 ? 0 : (-ret / 1000 ^ 0)
}

function useItem(socket, table, data) {
    switch (data.cheatId) {
    case 'skip':
        nextTurn.call(socket, table.id)
        break
    case 'reroll':
        rollDice.call(socket, { tableId: table.id }, false, true)
        break
    case 'shield':
    case 'flight':
    case 'free_shortcuts':
    case 'no_shortcuts':
        cheatChip(table, data)
        break
    case 'luck':
        cheatLuck(table, data)
        break
    case 'cat':
        cheatCat(socket, table, data)
        break
    }
    socket.emit('update-user-info', socket.user)
}
function cheatChip(table, { player, num, cheatId }) {
    const chip = table.game.chips[player][num]

    table.game.cheats.push({ cheatId, player, num, count: getCheatDuration(cheatId) })
    chip[cheatId] = true
    io.in(table.id).emit('cheat-updated', { player, num, on: true, cheatId })
    if (cheatId === 'no_shortcuts') {
        cheatExpired(table, 'free_shortcuts', player, num)
    }
    if (cheatId === 'free_shortcuts') {
        cheatExpired(table, 'no_shortcuts', player, num)
    }
}
function getNextCell(table, chip) {
    if (!table.game) {
        return
    }
    const scheme = table.game.scheme
    let start = scheme[chip.position]

    if (start.isSH) {
        if (scheme[start.links.outOfSH].chips.length && !chip.flight) {
            return
        } else {
            start = scheme[start.links.outOfSH]
        }
    }
    return start.links['toFinish' + chip.player] || start.links.for6 || start.links.next
}
function cheatCat(socket, table, { player, num }) {
    const chip = table.game.chips[player][num]
    const destination = getNextCell(table, chip)

    if (destination) {
        moveChipOnRoute(table, chip, [destination], false, true)
    }
}
function cheatLuck(table, { cheatId }) {
    const player = table.game.playersOrder[table.game.turn]

    table.game.cheats.push({ cheatId, player, count: 1 })
    table.players[table.game.turn][cheatId] = true
}
function validateCheat(table, socket, { player, num, cheatId }) {
    let ret

    if (player && num && table.game.chips[player]) {
        const chip = table.game.chips[player][num]

        if (getCheatDuration(cheatId) && chip[cheatId]) {
            ret = socket.emit('err', { text: cheatOn })
        } else if (cheatId === 'cat') {
            const destination = getNextCell(table, chip)

            if (!destination || (table.game.scheme[destination].chips.length && !table.game.scheme[destination].isStart)) {
                ret = socket.emit('err', { text: 'Котик туда не пойдет.' })
            }
        }
    } else if (cheatId === 'reroll') {
        if (!table.game.dice.length) {
            ret = socket.emit('err', { text: 'Сначала бросьте кубик, а уже потом решите нравится вам оно или нет.' })
        } else if (!table.game.dice[0] && !table.game.dice[1]) {
            ret = socket.emit('err', { text: 'Вы уже потратили оба кубика. Нечего перебрасывать.' })
        }
    }
    return !ret
}
function getCheatDuration(cheatId) {
    if (cheatId === 'shield') {
        return 3
    }
    if (cheatId === 'free_shortcuts') {
        return 10000
    }
    if (cheatId === 'flight') {
        return 3
    }
    if (cheatId === 'no_shortcuts') {
        return 10000
    }
}
function handleBuying(data) {
    if (!data || !data.id) {
        return
    }
    const cheat = cheats.find(ch => ch.id === data.id)

    if (!cheat) {
        return
    }

    pool.query(`
        UPDATE users
            set ${cheat.id} = ${cheat.id} + 1,
            ${cheat.currency} = ${cheat.currency} - ${cheat.price}
        WHERE vk_id = ${this.user.vk_id}
        returning ${cheat.id}, ${cheat.currency};
    `)
        .then(resp => {
            const row = resp.rows[0]

            this.user[cheat.id] = row[cheat.id]
            this.user[cheat.currency] = row[cheat.currency]

            this.emit('update-user-info', this.user)
        })
        .catch(() => this.emit('err', { text: errText }))
}
function updateCheats(table) {
    table.game.cheats.forEach((ch) => {
        if (table.game.playersOrder[table.game.turn] !== ch.player) {
            return
        }
        ch.count--
        if (!ch.count) {
            cheatExpired(table, ch.cheatId, ch.player, ch.num)
        }
    })
    table.game.cheats = table.game.cheats.filter(ch => ch.count)
}
function cheatExpired(table, cheatId, player, num) {
    if (num) {
        const chip = table.game.chips[player][num]

        chip[cheatId] && io.in(table.id).emit('cheat-updated', { player: chip.player, num: chip.num, on: false, cheatId })
        chip[cheatId] = false
    } else {
        table.players[table.game.turn][cheatId] = false
    }
}
function playerMadeMove(data) {
    const table = tablesList.findById(data.tableId)

    if (!table) {
        this.emit('player-made-move', { error: 'game not found' })
        return
    }
    const player = table.findPlayer(this.id)

    if (!player) {
        this.emit('player-made-move', { error: 'You are not in the game' })
        return
    }
    if (data.yourTurn !== table.game.turn) {
        this.emit('player-made-move', { error: 'not your turn' })
        return
    }

    if (!table.game.dice[data.diceNum] && data.diceNum !== false) {
        this.emit('player-made-move', { error: 'this dice already used' })
        return
    }

    const route = getRoute(table, data.diceNum, data.chipNum, data.targetId)

    if (route) {
        moveChipOnRoute(table, table.game.chips[table.game.playersOrder[data.yourTurn]][data.chipNum], route, data.diceNum)
    } else {
        this.emit('player-made-move', { error: 'Can\'t build route' })
    }
}
function autoMove(table) {
    if (!table.players[table.game.turn]) {
        return
    }
    const socket = io.sockets.connected[table.players[table.game.turn].id]

    if (!socket) {
        return
    }
    if (!table.game.diceRolled) {
        const playerIndex = tablesList.indexOfPlayer(table.id, socket.id)

        if (!~playerIndex) {
            return badErrorHandler('autoMove: player is not in game')
        }
        if (table.players[playerIndex].missedTurn) {
            io.to(socket.id).emit('removed')
            return playerDisconnected(table, socket.id)
        } else {
            table.players[playerIndex].missedTurn = true
        }
        rollDice.call(socket, { tableId: table.id }, true)
    } else {
        if (!table.game.dice[0] && !table.game.dice[1]) {
            if (table.game.doublesStreak) {
                rollDice.call(socket, { tableId: table.id }, true)
            } else {
                return nextTurn.call(socket, table.id)
            }
        } else {
            if (!makeRandomMove.call(socket, table)) {
                if (!table.game.doublesStreak) {
                    return nextTurn.call(socket, table.id)
                }
            }
        }
    }
    autoMove(table)
}
function makeRandomMove(table) {
    const dice = table.game.dice
    const possibleMoves = [];

    [1, 2, 3, 4].forEach(i => {
        const chip = table.game.chips[table.game.playersOrder[table.game.turn]][i]

        if (dice[0]) {
            getPossibleMoves(chip, dice[0], table).forEach(k => possibleMoves.push({ diceNum: '0', chipNum: i, targetId: k }))
        }
        if (dice[1]) {
            getPossibleMoves(chip, dice[1], table).forEach(k => possibleMoves.push({ diceNum: '1', chipNum: i, targetId: k }))
        }

        if (!chip.free_shortcuts) {
            return
        }
        const start = table.game.scheme[chip.position]

        if (start.links.for1) {
            possibleMoves.push({ targetId: start.links.for1, chipNum: i, diceNum: false })
        }
        if (start.links.for3) {
            possibleMoves.push({ targetId: start.links.for3, chipNum: i, diceNum: false })
        }
    })
    if (!possibleMoves.length) {
        table.game.dice[0] = table.game.dice[1] = undefined
        return false
    }
    const move = possibleMoves[(Math.random() * possibleMoves.length) ^ 0]

    playerMadeMove.call(this, { tableId: table.id, yourTurn: table.game.turn, chipNum: move.chipNum, targetId: move.targetId, diceNum: move.diceNum })
    return true
}
function chipCanMove(chip, table, cellId, notFinish) {
    if (!cellId || !table.game.scheme[cellId]) {
        return false
    }
    const toBeEatenId = table.game.scheme[cellId].chips[0]

    if (!toBeEatenId) {
        return true
    }
    if (notFinish) {
        return chip.flight
    } else {
        const toBeEaten = table.game.chips[toBeEatenId[16]][toBeEatenId[21]]

        return toBeEaten.player !== chip.player && !toBeEaten.shield
    }
}
function getPossibleMoves(chip, dice, table) {
    const scheme = table.game.scheme

    if (!chip || !dice) {
        return []
    }

    const chipCell = scheme[chip.position]
    const currentPlayer = table.game.playersOrder[table.game.turn]
    const result = []

    if (!chip.no_shortcuts && dice === 1 && chipCanMove(chip, table, chipCell.links.for1)) {
        result.push(chipCell.links.for1)
    }

    if (!chip.no_shortcuts && dice === 3 && chipCanMove(chip, table, chipCell.links.for3)) {
        result.push(chipCell.links.for3)
    }

    if (dice === 6 && chipCell.links.for6) {
        result.push(chipCell.links.for6)
    }

    if (!chip.isAtBase) {
        let current = chipCell
        let canMove = true

        if (current.isSH) {
            if (scheme[current.links.outOfSH].chips.length && !chip.flight) {
                return []
            } else {
                current = scheme[current.links.outOfSH]
            }
        }

        for (let i = 1; i <= dice; i++) {
            let toFinish = scheme[current.links['toFinish' + currentPlayer]]

            if (toFinish && chipCanMove(chip, table, toFinish.id, true)) {
                if (i === dice) {
                    result.push(toFinish.id)
                }
                for (let k = i + 1; k <= dice; k++) {
                    toFinish = scheme[toFinish.links.next]
                    if (!toFinish || !chipCanMove(chip, table, toFinish.id, true)) {
                        break
                    }

                    if (k === dice && toFinish) {
                        result.push(toFinish.id)
                    }
                }
            }
            canMove = chipCanMove(chip, table, current.links.next, i !== dice)
            if (!canMove) {
                break
            }
            current = scheme[current.links.next]
        }

        if (canMove) {
            result.push(current.id)

            if (!chip.no_shortcuts && current.links.end && chipCanMove(chip, table, current.links.end)) {
                result.push(current.links.end)
            }

            if (current.links.toSH && !scheme[current.links.toSH].chips.length) {
                result.push(current.links.toSH)
            }
        }
    }

    return result
}

function nextTurn(tableId, socketId = null) {
    let error, playerIndex, player
    const table = tablesList.findById(tableId);

    (function(){
        if (!table || !table.game) {
            return error = '404: Игра не найдена.'
        }

        playerIndex = tablesList.indexOfPlayer(tableId, socketId || this.id)
        player = table.players[playerIndex]

        if (!player) {
            return error = 'Игрок не участвует в игре!'
        }
        if (playerIndex !== table.game.turn) {
            return error = 'Не ваш ход!'
        }
    }).call(this)

    if (error) {
        return io.to(socketId || this.id).emit('dice-rolled', { error })
    }

    table.game.dice = []
    table.game.turn = table.getNextTurn()
    table.game.diceRolled = false
    clearTimeout(timers[tableId])
    timers[tableId] = setTimeout(autoMove.bind(null, table), 15000)
    updateCheats(table)
    io.in(table.id).emit('next-turn', { turn: table.game.turn, actionCount: ++table.game.actionCount })
}

function moveChipOnRoute(table, chip, route, diceNum, forceFlight = false) {
    table.game.dice[diceNum] = undefined
    io.in(table.id).emit('player-made-move', { playerNum: chip.player, num: chip.num, position: route[route.length - 1], diceNum, actionCount: ++table.game.actionCount, flight: chip.flight || forceFlight })

    for (let i = 0; i < route.length; i++) {
        moveChipToCell(table, chip, route[i])
        if (i === route.length - 1) {
            if (checkForWin(table, chip.player)) {
                gameWon(table, chip.player)
            }
        }
    }
}

function rollDice({ tableId } = {}, auto, cheat) {
    const table = tablesList.findById(tableId)
    let error, player;

    (function() {
        if (!table || !table.game) {
            return error = '404: Игра не найдена.'
        }

        player = tablesList.findPlayer(tableId, this.id)
        if (!player) {
            return error = 'Игрок не участвует в игре!'
        }

        if (tablesList.indexOfPlayer(table.id, this.id) !== table.game.turn) {
            return error = 'Не ваш ход!'
        }

        if (table.game.diceRolled && !table.game.doublesStreak && !cheat) {
            return error = 'Кубики уже брошены!'
        }

        if (cheat && !table.game.dice[0] && !table.game.dice[1]) {
            return error = 'Кубики потрачены!'
        }
    }).call(this)

    if (error) {
        return this.emit('dice-rolled', { error })
    }

    const dice = []

    if (cheat) {
        dice[0] = table.game.dice[0] && Math.ceil(Math.random() * 6)
        dice[1] = table.game.dice[1] && Math.ceil(Math.random() * 6)
    } else {
        dice[0] = Math.ceil(Math.random() * 6)
        dice[1] = Math.ceil(Math.random() * 6)
    }

    if (!dice[0]) {
        dice[0] = null
    }
    if (!dice[1]) {
        dice[1] = null
    }
    if (dice[0] && dice[1] && table.players[table.game.turn].luck) {
        dice[1] = dice[0]
    }
    if (!cheat && dice[0] === dice[1]) {
        table.game.doublesStreak = table.game.doublesStreak === 2 ? 0 : table.game.doublesStreak + 1
    } else {
        table.game.doublesStreak = 0
    }

    table.game.dice = dice
    table.game.diceRolled = true
    io.in(tableId).emit('dice-rolled', { dice, actionCount: ++table.game.actionCount, cheat, doublesStreak: table.game.doublesStreak })
    clearTimeout(timers[table.id])
    timers[table.id] = setTimeout(autoMove.bind(null, table), 45000)
    auto || (table.players[table.game.turn].missedTurn = false)
}
function gameWon(table, playerNum) {
    const defaultCh = defaultChange(table.players.length)

    table.players.forEach((player, i) => {
        player.won = table.game.playersOrder[i] === playerNum
        if (player.left || player.won) {
            return
        }
        player.movesToFinish = getPlayerCellsToFinish(table, playerNum)
    })

    const sorted = table.players.slice().sort((a, b) => {
        if (a.left !== b.left) {
            return a.left ? 1 : -1
        }
        if (a.left && b.left) {
            return 0
        }
        return a.movesToFinish - b.movesToFinish
    })

    sorted.forEach((pl, i) => {
        pl.deltaBet = pl.won ? (table.bet * (table.players.length - 1)) : -table.bet
        if (pl.left) {
            pl.deltaRank = -30
        } else {
            let dif = (table.rating - pl.rating) / 200

            dif = dif > 15 ? 15 : dif
            dif = dif < -15 ? -15 : dif
            pl.deltaRank = Math.round(defaultCh[i] + dif)
        }
    })

    pool.query(`UPDATE users SET 
                    rating = rating + tmp.delta_rank,
                    chips = chips + tmp.delta_bet
                    from (values
                        ${sorted.filter(i => !i.lvalidateCheateft).map(pl => `(${pl.vk_id}, ${pl.deltaRank}, ${pl.deltaBet})`)}
                    ) as tmp(vk_id, delta_rank, delta_bet) where users.vk_id = tmp.vk_id returning *;`)
        .then(res => {
            const results = sorted.map((pl) => {
                const usersRes = res.rows.find(r => r.vk_id === pl.vk_id)

                if (usersRes) {
                    pl.rating = usersRes.rating
                    pl.chips = usersRes.chips
                    if (pl.socket && pl.socket.user) {
                        pl.socket.user.rating = pl.rating
                        pl.socket.user.chips = pl.chips
                        pl.left || pl.socket.emit('update-user-info', cloneDeep(pl.socket.user))
                    }
                } else {
                    pl.rating -= 30
                }
                return {
                    id: pl.id,
                    vk_id: pl.vk_id,
                    name: pl.name,
                    rating: pl.rating,
                    deltaRank: pl.deltaRank,
                    deltaChips: pl.won ? (table.bet * (table.players.length - 1)) : -table.bet,
                    isWinner: pl.won
                }
            })

            table.game.finished = true
            clearTimeout(timers[table.id])
            table.players = table.players.filter(pl => !pl.left)
            table.updateRating()
            io.in(table.id).emit('player-won', { results, actionCount: ++table.game.actionCount })
            table.updatePlayers({ afterWin: true })
        })
        .catch(err => console.error('Error executing query', err.stack))
}
const defaultChangeOptions = [[], [], [15, -15], [17, 0, -17], [20, 10, -10, -20]]

function defaultChange(num) {
    return defaultChangeOptions[num]
}
function moveChipToCell(table, chip, destination, toBase = false) {
    const scheme = table.game.scheme

    scheme[chip.position].chips.splice(scheme[chip.position].chips.indexOf(chip.id), 1)

    chip.position = destination
    chip.isAtBase = toBase

    if (scheme[destination].chips.length && getPlayerFromCell(table, destination) != chip.player) {
        const eatenChipPlayer = scheme[destination].chips[0][16]
        const eatenChipNum = scheme[destination].chips[0][21]

        moveChipToCell(table, table.game.chips[eatenChipPlayer][eatenChipNum], `game_chip-base_chip-space_player${eatenChipPlayer}_num${eatenChipNum}`, true)
    }

    scheme[destination].chips.push(chip.id)
}

function getRoute(table, diceNum, chipNum, cellId) {
    const scheme = table.game.scheme
    let result = []

    const dice = table.game.dice[diceNum]
    const currentPlayer = table.game.playersOrder[table.game.turn]
    const chip = table.game.chips[currentPlayer][chipNum]
    const chipCell = scheme[chip.position]

    if (diceNum === false) {
        if (!chip.free_shortcuts) {
            return []
        }

        if (chipCell.links.for1 === cellId) {
            return [ chipCell.links.for1 ]
        }
        if (chipCell.links.for3 === cellId) {
            return [ chipCell.links.for3 ]
        }
    }

    if (!chip.no_shortcuts && dice === 1 && chipCell.links.for1 === cellId && chipCanMove(chip, table, cellId)) {
        return [chipCell.links.for1]
    }

    if (!chip.no_shortcuts && dice === 3 && chipCell.links.for3 === cellId && chipCanMove(chip, table, cellId)) {
        return [chipCell.links.for3]
    }

    if (dice === 6 && chipCell.links.for6 && chipCell.links.for6 === cellId) {
        return [chipCell.links.for6]
    }

    const route = []

    if (!chip.isAtBase) {
        let current = chipCell
        let canMove = true
        const toFinish = cellId.indexOf('game_cell-finish') !== -1

        if (current.isSH) {
            if (scheme[current.links.outOfSH].chips.length && !chip.flight) {
                return false
            } else {
                route.push(current.links.outOfSH)
                current = scheme[current.links.outOfSH]
            }
        }

        for (let i = 1; i <= dice; i++) {
            if (toFinish) {
                current = scheme[(current.links['toFinish' + currentPlayer]) || current.links.next]
            } else {
                current = scheme[current.links.next]
            }

            if (!current) {
                return false
            }

            canMove = chipCanMove(chip, table, current.id, i !== dice)
            route.push(current.id)

            if (!canMove) {
                break
            }
        }

        if (canMove) {
            if (!chip.no_shortcuts && current.links.end && current.links.end === cellId) {
                route.push(current.links.end)
            }
            if (current.links.toSH && current.links.toSH === cellId) {
                route.push(current.links.toSH)
            }

            result = route
        }
        if (!result.length) {
            return false
        }
        if (chip.flight && result.length) {
            result = [result[result.length - 1]]
        }
    }
    return result
}

function updateCountDown(table) {
    const nums2colors = ['', 'красному', 'зелёному', 'синему', 'жёлтому']
    const turnOff = table.players.length === 1 || table.players.some(pl => !pl.ready)

    clearTimeout(timers[table.id])
    io.in(table.id).emit('all-players-ready', { cancel: turnOff })

    if (!turnOff) {
        timers[table.id] = setTimeout(() => {
            table.game = newGame(table.players)
            table.players.forEach(pl => pl.ready = false)
            io.in(table.id).emit('game-start', { turn: table.game.turn, players: table.players, actionCount: 0 })
            timers[table.id] = setTimeout(() => autoMove.call(null, table), 16500) // should be 15000
            io.in(table.id).emit('new-msg', { room: table.id, text: `Первый ход достался ${nums2colors[table.game.playersOrder[table.game.turn]]} игроку`, player: { id: 'auto', name: 'Компьютер' } })
            // moveChipOnRoute(table, table.game.chips[1][1], ['game_cell-finish_player1_4'], 'test');
            // moveChipOnRoute(table, table.game.chips[1][2], ['game_cell-finish_player1_3'], 'test');
            // moveChipOnRoute(table, table.game.chips[1][3], ['game_cell-finish_player1_2'], 'test');
            // moveChipOnRoute(table, table.game.chips[1][4], ['game_cell47'], 'test');
            // moveChipOnRoute(table, table.game.chips[1][4], ['game_cell45'], 'test');
        }, 5000)
    }
}

function playerDisconnected(table, socketId) {
    const game = table.game

    if (game && !game.finished) {
        playerLeftTheGame(table, socketId)
    } else {
        if (table.players.length === 1) {
            tablesList.remove(table.id)
        } else {
            table.removePlayer(socketId)
            table.updatePlayers({ afterWin: true })
            updateCountDown(table)
        }
    }
}
function playerLeftTheGame(table, socketId) {
    const playerIndex = table.indexOfPlayer(socketId)
    const player = table.players[playerIndex]
    const playerNum = table.game.playersOrder[playerIndex]

    player.left = true

    io.in(table.id).emit('player-left', { playerIndex });

    [1, 2, 3, 4].forEach((chipNum) => {
        moveChipToCell(table, table.game.chips[playerNum][chipNum], `game_chip-base_chip-space_player${playerNum}_num${chipNum}`, true)
    })
    if (table.game.turn === playerIndex) {
        nextTurn(table.id, socketId)
    }
    pool.query(`UPDATE users SET rating = rating - 30, chips = chips - ${table.bet} where vk_id = ${player.vk_id} returning *;`)
        .then(res => {
            const socket = player.socket

            if (socket && socket.user) {
                socket.user.chips = res.rows[0].chips
                socket.user.rating = res.rows[0].rating
                socket.emit('update-user-info', socket.user)
            }
        }).catch(badErrorHandler)

    if (table.isOnePlayerLeft) {
        const winnerIndex = table.players.findIndex(pl => !pl.left)

        gameWon(table, table.game.playersOrder[winnerIndex])
    }
}

function getPlayerCellsToFinish(table, playerNum) {
    return table.game.chips[playerNum].reduce((sum, chip) => {
        if (chip.isAtBase) {
            return sum + 54
        }
        if (table.game.scheme[chip.position].isFinish) {
            return sum
        }
        return sum + getCellsToFinish(table.game.scheme, playerNum, chip.position)
    }, 0)
}

function getCellsToFinish(scheme, playerNum, position) {
    const preFinishCell = 'game_cell' + (60 - playerNum * 12)
    let current = scheme[position]
    let ret = 0

    if (current.isSH) {
        current = scheme[current.links.outOfSH]
    }

    while (current.id !== preFinishCell) {
        current = scheme[current.links.next]
        ret++
    }
    return ret
}

function createScheme() {
    const ret = {}

    for (let i = 1; i <= 48; i++) {
        const k = {}
        const id = 'game_cell' + i

        k.chips = []
        const links = {}

        links.next = 'game_cell' + (i === 48 ? 1 : (i + 1))
        k.links = links
        k.id = id
        ret[id] = k

        if (i % 12 === 0) {
            const n = (60 - i) / 12

            k.links['toFinish' + n] = `game_cell-finish_player${n}_1`;

            [1, 2, 3, 4].forEach(k => {
                const finish = {
                    isFinish: true,
                    id: `game_cell-finish_player${n}_${k}`,
                    chips: []
                }

                finish.links = { next: (k === 4 ? null : `game_cell-finish_player${n}_${k + 1}`) }

                ret[finish.id] = finish
            })
        }
        if (i % 12 === 1) {
            const startMap = {
                1: 1,
                13: 4,
                25: 3,
                37: 2
            }
            const n = startMap[i]

            const start = {
                isStart: true,
                id:('game_start-cell_player' + n),
                chips: [],
                links: { next: id }
            }

            ret[start.id] = start;

            [1, 2, 3, 4].forEach(k => {
                const baseId = `game_chip-base_chip-space_player${n}_num${k}`
                const base = { id: baseId, isBase: true, links: { for6: start.id }, chips: [] }

                ret[baseId] = base
            })

        }
        if (i % 12 === 2) {
            links.end = 'game_cell' + (i + 7)
        }
        if (i % 12 === 6) {
            links.for1 = 'game_cell' + (i === 42 ? 6 : i + 12)
            links.for3 = 'game_cell' + (i + 24 > 48 ? i - 24 : i + 24)
        }
        if (i % 12 === 10) {
            links.toSH = 'game_cell-safe-house' + ((i - 10) / 12)
            const sh = {
                isSH: true,
                chipId: null,
                id: links.toSH,
                links: { outOfSH: id },
                chips: []
            }

            ret[sh.id] = sh
        }
    }

    return ret
}

function newGame(players) {
    const ret = {
        id: ('id_' + (Math.random() * 100000000 ^ 0)),
        playersOrder: getPlayersOrder(players.length),
        dice: [],
        chips: defaultChipsPositions(getPlayersOrder(players.length)),
        cheats: [],
        turn: (Math.random() * players.length ^ 0),
        scheme: createScheme(),
        doublesStreak: 0,
        actionCount: 0
    }

    players.forEach((pl, i) => {
        pl.missedTurn = false
        pl.playerNum = ret.playersOrder[i]
        pl.movesToFinish = 0
        pl.won = false
    })

    return ret
}

function defaultChipsPositions(playersOrder) {
    const ret = {}

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

    return ret
}

const orderOptions = [[], [1], [1, 3], [1, 2, 3], [1, 2, 3, 4]]

function getPlayersOrder(num) {
    return orderOptions[num]
}
function getPlayerFromCell(table, cellId) {
    if (!table.game) {
        return null
    }

    const chipId = table.game.scheme[cellId].chips[0]

    return chipId && chipId[16] ? +chipId[16] : null
}

function checkForWin(table, playerNum) {
    const scheme = table.game.scheme

    for (let i = 1; i < 5; i++) {
        if (scheme[`game_cell-finish_player${playerNum}_${i}`].chips.length !== 1) {
            return false
        }
    }
    return true
}

function updateRecords() {
    pool.query('SELECT vk_id, rating from users order by rating desc limit 20;')
        .then(res => topByRank = res.rows)
    pool.query('SELECT vk_id, chips from users order by chips desc limit 20;')
        .then(res => topByChips = res.rows)
}

function userBought(vk_id, itemId) {
    const item = moneyItems.find(i => i.item_id === itemId)

    if (!item) {
        return
    }
    pool.query(`UPDATE users SET ${item.unit} = ${item.unit} + ${item.qty} WHERE vk_id = ${vk_id} returning ${item.unit}, socket_id;`)
        .then(res => {
            if (!res.rows.length) {
                console.log(`Пользователь, с id ${vk_id} зарегистрирован в приложении, но сделал покупку айтема `, itemId)
                return
            }

            const socket = io.sockets.connected[res.rows[0].socket_id]

            if (socket && socket.user) {
                socket.user[item.unit] = res.rows[0][item.unit]
                socket.emit('update-user-info', socket.user)
            }
        })
        .catch(() => {
            badErrorHandler(`Ошибка при покупке ${itemId} пользователем ${vk_id}`)
        })
}
