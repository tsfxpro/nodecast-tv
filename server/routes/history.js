const express = require('express');
const router = express.Router();
const { getDb } = require('../db/sqlite');
const { requireAuth } = require('../auth');

// Middleware to ensure authentication
router.use(requireAuth);

// Per-user cache for recently watched channels
const CHANNELS_CACHE_TTL = 25 * 60 * 60 * 1000; // 25h — invalidated immediately on each watch, TTL is just a safety net
const recentChannelsCache = new Map();

function queryRecentChannels(userId, limit) {
    return getDb().prepare(`
        SELECT wh.item_id, wh.source_id, wh.updated_at,
               pi.name, pi.stream_icon
        FROM watch_history wh
        LEFT JOIN playlist_items pi
            ON  pi.item_id   = wh.item_id
            AND pi.source_id = wh.source_id
            AND pi.type      = 'live'
        WHERE wh.user_id = ? AND wh.item_type = 'live'
        ORDER BY wh.updated_at DESC
        LIMIT ?
    `).all(userId, limit);
}

function warmChannelsCache() {
    try {
        const db = getDb();
        const users = db.prepare(`SELECT DISTINCT user_id FROM watch_history WHERE item_type = 'live'`).all();
        for (const { user_id } of users) {
            recentChannelsCache.set(user_id, { data: queryRecentChannels(user_id, 10), timestamp: Date.now() });
        }
        console.log(`[Cache] Recent channels cache warmed for ${users.length} user(s)`);
    } catch (err) {
        console.error('[Cache] Recent channels cache warm failed:', err.message);
    }
}

/**
 * GET /api/history/channels
 * Returns the 10 most recently watched live channels for the authenticated user
 */
router.get('/channels', (req, res) => {
    try {
        const userId = req.user.id;
        const limit = parseInt(req.query.limit) || 10;
        const entry = recentChannelsCache.get(userId);
        if (entry && (Date.now() - entry.timestamp) < CHANNELS_CACHE_TTL) {
            return res.json(entry.data);
        }
        const rows = queryRecentChannels(userId, limit);
        recentChannelsCache.set(userId, { data: rows, timestamp: Date.now() });
        res.json(rows);
    } catch (err) {
        console.error('[History] Error fetching recent channels:', err);
        res.status(500).json({ error: 'Failed to fetch recent channels' });
    }
});

/**
 * GET /api/history
 * Returns the watch history for the authenticated user
 */
router.get('/', (req, res) => {
    try {
        const db = getDb();
        const userId = req.user.id;
        const limit = parseInt(req.query.limit) || 20;

        const excludeType = req.query.excludeType;
        const rows = excludeType
            ? db.prepare(`SELECT * FROM watch_history WHERE user_id = ? AND item_type != ? ORDER BY updated_at DESC LIMIT ?`).all(userId, excludeType, limit)
            : db.prepare(`SELECT * FROM watch_history WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`).all(userId, limit);

        const history = rows.map(row => ({
            ...row,
            data: JSON.parse(row.data || '{}')
        }));

        res.json(history);
    } catch (err) {
        console.error('[History] Error fetching history:', err);
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});

/**
 * POST /api/history
 * Saves/updates watch progress for an item
 */
router.post('/', (req, res) => {
    try {
        const db = getDb();
        const userId = req.user.id;
        const { id, type, parentId, progress, duration, data, sourceId } = req.body;

        if (!id || !type) {
            return res.status(400).json({ error: 'Missing required fields (id, type)' });
        }

        const compositeId = `${userId}:${id}`;
        const timestamp = Date.now();

        const stmt = db.prepare(`
            INSERT INTO watch_history (id, user_id, source_id, item_type, item_id, parent_id, progress, duration, updated_at, data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                source_id = excluded.source_id,
                progress = excluded.progress,
                duration = excluded.duration,
                updated_at = excluded.updated_at,
                data = excluded.data
        `);

        stmt.run(
            compositeId,
            userId,
            sourceId || null,
            type,
            id.toString(),
            parentId ? parentId.toString() : null,
            progress || 0,
            duration || 0,
            timestamp,
            JSON.stringify(data || {})
        );

        if (type === 'live') recentChannelsCache.delete(userId);
        res.json({ success: true, timestamp });
    } catch (err) {
        console.error('[History] Error saving progress:', err);
        res.status(500).json({ error: 'Failed to save progress' });
    }
});

/**
 * DELETE /api/history/:itemId
 * Removes an item from the user's watch history
 */
router.delete('/:itemId', (req, res) => {
    try {
        const db = getDb();
        const userId = req.user.id;
        const itemId = req.params.itemId;

        const compositeId = `${userId}:${itemId}`;

        const stmt = db.prepare('DELETE FROM watch_history WHERE id = ? AND user_id = ?');
        const result = stmt.run(compositeId, userId);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Item not found in history' });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[History] Error deleting history item:', err);
        res.status(500).json({ error: 'Failed to delete history item' });
    }
});

module.exports = router;
module.exports.warmChannelsCache = warmChannelsCache;
