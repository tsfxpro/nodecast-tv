const { Store } = require('express-session');
const { getDb } = require('../db/sqlite');
const log = require('../utils/logger');

// Prune expired sessions every 15 minutes
const PRUNE_INTERVAL_MS = 15 * 60 * 1000;

class SqliteSessionStore extends Store {
    constructor() {
        super();
        const db = getDb();
        db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                sid  TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                expires_at INTEGER NOT NULL
            )
        `);
        setInterval(() => this._prune(), PRUNE_INTERVAL_MS).unref();
    }

    get(sid, cb) {
        try {
            const row = getDb()
                .prepare('SELECT data FROM sessions WHERE sid = ? AND expires_at > ?')
                .get(sid, Date.now());
            cb(null, row ? JSON.parse(row.data) : null);
        } catch (err) { cb(err); }
    }

    set(sid, session, cb) {
        try {
            const ttl = session.cookie?.maxAge ?? 86400000;
            const expires_at = Date.now() + ttl;
            getDb()
                .prepare('INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at')
                .run(sid, JSON.stringify(session), expires_at);
            cb(null);
        } catch (err) { cb(err); }
    }

    destroy(sid, cb) {
        try {
            getDb().prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
            cb(null);
        } catch (err) { cb(err); }
    }

    touch(sid, session, cb) {
        this.set(sid, session, cb);
    }

    _prune() {
        try {
            getDb().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
        } catch (err) {
            log.warn('[Sessions] Prune failed:', err.message);
        }
    }
}

module.exports = SqliteSessionStore;
