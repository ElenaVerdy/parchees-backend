ttsbegin;

CREATE TABLE users (
    id                  serial primary key,
    vk_id               integer DEFAULT 0,
    rating              integer DEFAULT 2000,
    socket_id           varchar(128),
    first_name          varchar(256),
    last_name           varchar(256),
    photo_50            varchar(256),
    photo_100           varchar(256),
    chips               integer DEFAULT 2000,
    money               integer DEFAULT 1000,
    games_total         integer DEFAULT 0,
    games_won           integer DEFAULT 0,
    longest_game        integer DEFAULT 0,

    skip                integer DEFAULT 0,
    reroll              integer DEFAULT 0,
    shield              integer DEFAULT 0,
    runaway             integer DEFAULT 0,
    no_shortcuts        integer DEFAULT 0,
    cat                 integer DEFAULT 0,
    luck                integer DEFAULT 0,
    free_shortcuts      integer DEFAULT 0,
    flight              integer DEFAULT 0,
    move_back           integer DEFAULT 0,
    last_lottery        timestamp DEFAULT to_timestamp(0),

    constraint rating       check (rating >= 0),
    constraint chips        check (chips >= 0),
    constraint money        check (money >= 0),
    constraint games_total  check (games_total >= 0),
    constraint games_won    check (games_won >= 0),
    constraint longest_game check (longest_game >= 0),
    constraint skip         check (skip >= 0),
    constraint reroll       check (reroll >= 0),
    constraint shield       check (shield >= 0),
    constraint luck         check (luck >= 0),
    constraint runaway      check (runaway >= 0),
    constraint no_shortcuts check (no_shortcuts >= 0),
    constraint free_shortcuts check (free_shortcuts >= 0),
    constraint flight       check (flight >= 0),
    constraint move_back    check (move_back >= 0)
);

alter table users add column socket_id varchar(128);
/*****************/
CREATE INDEX email_idx ON users (email);

INSERT INTO users (username, email) values ('Guest', 'MinesSlayer');

CREATE TABLE passwords (
    id                  integer primary key references users(id),
    st                  varchar(50),
    fh                  varchar(355)
);

CREATE TYPE gametype AS ENUM ('easy', 'medium', 'hard');

CREATE TABLE recordssingleplayer (
    gameid              serial primary key,
    timems              integer NOT NULL,
    gametype            gametype NOT NULL,
    created_at          TIMESTAMPTZ DEFAULT Now(),
    playerusername      varchar(50) references users(username) NOT NULL
);
CREATE INDEX recordssingleplayer_timems_idx ON recordssingleplayer (timems);

CREATE TABLE recordstwoplayers (
    gameid                  serial primary key,
    timems                  integer NOT NULL,
    created_at              TIMESTAMPTZ DEFAULT Now(),
    player1username        	varchar(50) references users(username) NOT NULL,
    player2username        	varchar(50) references users(username) NOT NULL    
);

CREATE INDEX recordstwoplayers_timems_idx ON recordstwoplayers (timems);

ttsCommit;