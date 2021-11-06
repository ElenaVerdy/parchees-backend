const Table = require('./Table');

class TablesList {
    #list = [];
    #io;

    constructor (io) {
        this.#io = io

        this.availableTables = [];
        this.playersInGame = 0;
        this.playersConnected = 0;

        this.updAvailableTables();
    }

    remove (tableId) {
        let tableIndex = this.#list.findIndex(table => table.id === tableId);
    
        if (tableIndex === -1) return false;
    
        this.#list.splice(tableIndex, 1);
    
        return true;
    }

    findById (id) {
        return this.#list.find(table => table.id === id)
    }

    removePlayer (tableId, socketId) {
        let table = this.findById(tableId);

        if (!table) return false;

        return table.removePlayer(socketId)
    }

    findPlayer (tableId, socketId) {
        let table = this.findById(tableId);

        if (!table) return false;

        return table.findPlayer(socketId)
    }

    indexOfPlayer (tableId, socketId) {
        let table = this.findById(tableId);

        if (!table || !table.game) return -1;

        return table.indexOfPlayer(socketId);
    }

    updAvailableTables () {
        let playersInGame = 0;

        let availableTables = this.#list.filter(table => {
            return table.isOpen
        });

        availableTables = availableTables.map(table => {
            playersInGame += table.players.length;

            return {
                tableId: table.id,
                players: table.players,
                rating: table.rating,
                bet: table.bet
            };
        });

        this.playersInGame = playersInGame;
        this.availableTables = availableTables;

        setTimeout(this.updAvailableTables.bind(this), 500);
    }

    addTable ({ bet }) {
        const newTable = new Table({
            players: [],
            bet,
            io: this.#io
        })

        this.#list.push(newTable)

        return newTable
    }
}

module.exports = TablesList
