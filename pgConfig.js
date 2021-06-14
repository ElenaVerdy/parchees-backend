const pgConfig = {
    connectionString: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/parcheesi",
}

if (process.env.DATABASE_URL) {
    pgConfig.ssl = {
        rejectUnauthorized: false
    }
}

module.exports = pgConfig