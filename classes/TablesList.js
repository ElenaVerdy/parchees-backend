class TablesList {
    #list = [];

    constructor () {
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
    
        let player = table.players.find(player => player.id === socketId);
    
        if (!player) return false;
    
        table.players.splice(table.players.indexOf(player), 1);
    
        return true;
    }

    findPlayer (tableId, socketId) {
        let table = this.findById(tableId);
    
        if (!table) return false;
        
        let player = table.players.find(player => player.id === socketId);
    
        return player || false;
    }

    indexOfPlayer (tableId, socketId) {
        let table = this.findById(tableId);
        
        if (!table || !table.game) return -1;
    
        let player = table.players.find(player => player.id === socketId);
        
        if (!player) return -1;
    
        return table.players.indexOf(player);
    }

    updAvailableTables () {
        let playersInGame = 0;

        let availableTables = this.#list.filter(i => {
            return i.players.length !== 4 && (!i.game || i.game.finished);
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

    getNewTableId () {
        return "t_" + (Math.random() * 100000000 ^ 0);
    }

    addTable ({ players, bet }) {
        const newTable = {
            id: this.getNewTableId(),
            chat: [],
            players,
            rating: players[0].rating,
            bet
        }

        this.#list.push(newTable)

        return newTable.id
    }
}

module.exports = TablesList
