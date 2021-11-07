class Table {
    #io

    constructor ({ players, bet, io }) {
        this.#io = io

        this.id = `t_${Math.random() * 100000000 ^ 0}`
        this.chat = []
        this.players = players
        this.rating = 0
        this.bet = bet
    }

    get isOpen () {
        return this.players.length !== 4 && (!this.game || this.game.finished)
    }

    get isOnePlayerLeft() {
        return this.players.filter(pl => !pl.left).length === 1
    }

    addPlayer (socket) {
        const newPlayer = {
            id: socket.id,
            ready: false,
            name: socket.user.name,
            photo_50: socket.user.photo_50,
            photo_100: socket.user.photo_100,
            vk_id: socket.user.vk_id,
            rating: socket.user.rating,
            socket
        }

        Object.defineProperty(newPlayer, 'socket', { enumerable: false })

        this.players.push(newPlayer)

        socket.emit('connect-to', { id: this.id, players: this.players, bet: this.bet })
        socket.join(this.id)

        this.updateRating()
    }

    removePlayer (socketId) {
        const playerIndex = this.indexOfPlayer(socketId)

        if (playerIndex === -1) {
            return false
        }

        this.players.splice(playerIndex, 1)

        this.updateRating()

        return true
    }

    findPlayer (socketId) {
        return this.players.find(player => player.id === socketId)
    }

    indexOfPlayer (socketId) {
        return this.players.findIndex(player => player.id === socketId)
    }

    updateRating () {
        this.rating = this.players
            .map(pl => pl.rating)
            .reduce((a, b) => a + b, 0) / this.players.length ^ 0
    }

    getNextTurn() {
        let ret = this.game.turn

        for (let i = 0; i < 4; i++) {
            ret = ((ret + 1) === this.players.length) ? 0 : ret + 1

            if (!this.players[ret].left) {
                return ret
            }
        }
    }

    updatePlayers ({ afterWin } = {}) {
        this.#io.in(this.id).emit('update-players', {
            players: this.players,
            tableId: this.id,
            afterWin
        })
    }
}

module.exports = Table
