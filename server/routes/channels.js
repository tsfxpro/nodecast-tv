const log = require('../utils/logger');
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/sqlite');

// 25h matches the proxy DB_CACHE_TTL — data only changes on sync cycles
const RECENT_CACHE_TTL = 25 * 60 * 60 * 1000;
const recentCache = new Map();

function getRecentCached(type, limit) {
    const entry = recentCache.get(`${type}_${limit}`);
    if (entry && (Date.now() - entry.timestamp) < RECENT_CACHE_TTL) return entry.data;
    return null;
}

function setRecentCached(type, limit, data) {
    recentCache.set(`${type}_${limit}`, { data, timestamp: Date.now() });
}

function clearRecentCache() {
    recentCache.clear();
}

function queryRecent(type, limit) {
    const db = getDb();
    const rows = db.prepare(`
        SELECT * FROM playlist_items p
        WHERE p.type = ?
          AND p.is_hidden = 0
          AND p.category_id NOT IN (
              SELECT category_id FROM categories WHERE type = ? AND is_hidden = 1
          )
        ORDER BY p.added_at DESC
        LIMIT ?
    `).all(type, type, limit);
    return rows.map(item => ({ ...item, data: JSON.parse(item.data) }));
}

function warmRecentCache() {
    try {
        for (const type of ['movie', 'series']) {
            setRecentCached(type, 12, queryRecent(type, 12));
        }
        log.info('[Cache] Recent items cache warmed');
    } catch (err) {
        log.warn('[Cache] Recent items cache warm failed:', err.message);
    }
}

// Helper to map API item types to DB types and tables
function mapItemType(apiType) {
    switch (apiType) {
        case 'channel': return { table: 'playlist_items', type: 'live' };
        case 'group': return { table: 'categories', type: 'live' };
        case 'vod_category': return { table: 'categories', type: 'movie' };
        case 'series_category': return { table: 'categories', type: 'series' };
        case 'movie': return { table: 'playlist_items', type: 'movie' };
        case 'series': return { table: 'playlist_items', type: 'series' };
        default: return null;
    }
}

// Get all hidden items (formatted like db.json for frontend compatibility)
router.get('/hidden', async (req, res) => {
    try {
        const { sourceId } = req.query;
        const db = getDb();

        let hidden = [];
        const resultFormat = (row, itemType) => ({
            source_id: row.source_id,
            item_type: itemType,
            item_id: itemType.includes('category') || itemType === 'group' ? row.category_id : row.item_id
        });

        // Query Categories
        let catQuery = `SELECT source_id, category_id, type FROM categories WHERE is_hidden = 1`;
        let itemQuery = `SELECT source_id, item_id, type FROM playlist_items WHERE is_hidden = 1`;

        const params = [];
        if (sourceId) {
            catQuery += ` AND source_id = ?`;
            itemQuery += ` AND source_id = ?`;
            const sid = parseInt(sourceId);
            params.push(sid);
        }

        const hiddenCats = db.prepare(catQuery).all(...params);
        const hiddenItems = db.prepare(itemQuery).all(...params);

        hiddenCats.forEach(row => {
            let apiType;
            if (row.type === 'live') apiType = 'group';
            else if (row.type === 'movie') apiType = 'vod_category';
            else if (row.type === 'series') apiType = 'series_category';

            if (apiType) hidden.push(resultFormat(row, apiType));
        });

        hiddenItems.forEach(row => {
            let apiType;
            if (row.type === 'live') apiType = 'channel';
            else if (row.type === 'movie') apiType = 'movie';
            else if (row.type === 'series') apiType = 'series';

            if (apiType) hidden.push(resultFormat(row, apiType));
        });

        res.json(hidden);
    } catch (err) {
        log.error('Error getting hidden items:', err);
        res.status(500).json({ error: 'Failed to get hidden items' });
    }
});

// Hide item
router.post('/hide', async (req, res) => {
    try {
        const { sourceId, itemType, itemId } = req.body;
        const mapping = mapItemType(itemType);

        if (!mapping) return res.status(400).json({ error: 'Invalid item type' });

        const db = getDb();
        const idCol = mapping.table === 'categories' ? 'category_id' : 'item_id';

        const stmt = db.prepare(`
            UPDATE ${mapping.table} 
            SET is_hidden = 1 
            WHERE source_id = ? AND type = ? AND ${idCol} = ?
        `);

        stmt.run(sourceId, mapping.type, itemId);
        clearRecentCache();
        res.json({ success: true });
    } catch (err) {
        log.error('Error hiding item:', err);
        res.status(500).json({ error: 'Failed to hide item' });
    }
});

// Show item
router.post('/show', async (req, res) => {
    try {
        const { sourceId, itemType, itemId } = req.body;
        const mapping = mapItemType(itemType);

        if (!mapping) return res.status(400).json({ error: 'Invalid item type' });

        const db = getDb();
        const idCol = mapping.table === 'categories' ? 'category_id' : 'item_id';

        const stmt = db.prepare(`
            UPDATE ${mapping.table} 
            SET is_hidden = 0 
            WHERE source_id = ? AND type = ? AND ${idCol} = ?
        `);

        stmt.run(sourceId, mapping.type, itemId);
        clearRecentCache();
        res.json({ success: true });
    } catch (err) {
        log.error('Error showing item:', err);
        res.status(500).json({ error: 'Failed to show item' });
    }
});

// Check hidden status
router.get('/hidden/check', async (req, res) => {
    try {
        const { sourceId, itemType, itemId } = req.query;
        const mapping = mapItemType(itemType);
        if (!mapping) return res.json({ hidden: false });

        const db = getDb();
        const idCol = mapping.table === 'categories' ? 'category_id' : 'item_id';

        const row = db.prepare(`
            SELECT is_hidden FROM ${mapping.table} 
            WHERE source_id = ? AND type = ? AND ${idCol} = ?
        `).get(sourceId, mapping.type, itemId);

        res.json({ hidden: !!(row && row.is_hidden) });
    } catch (err) {
        log.error('Error checking hidden:', err);
        res.status(500).json({ error: 'Failed to check status' });
    }
});

// Bulk Hide
router.post('/hide/bulk', async (req, res) => {
    try {
        const { items } = req.body;
        if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });

        const db = getDb();

        // Prepare statements once
        const hideCat = db.prepare('UPDATE categories SET is_hidden = 1 WHERE source_id = ? AND type = ? AND category_id = ?');
        const hideItem = db.prepare('UPDATE playlist_items SET is_hidden = 1 WHERE source_id = ? AND type = ? AND item_id = ?');

        // Cascading statements (hide all children of a category)
        const hideCatChildren = db.prepare('UPDATE playlist_items SET is_hidden = 1 WHERE source_id = ? AND type = ? AND category_id = ?');

        const runBulk = db.transaction((list) => {
            for (const item of list) {
                const mapping = mapItemType(item.itemType);
                if (mapping) {
                    if (mapping.table === 'categories') {
                        // Hide the category
                        hideCat.run(item.sourceId, mapping.type, item.itemId);
                        // Cascade to children
                        hideCatChildren.run(item.sourceId, mapping.type, item.itemId);
                    } else {
                        // Hide individual item
                        hideItem.run(item.sourceId, mapping.type, item.itemId);
                    }
                }
            }
        });

        runBulk(items);
        clearRecentCache();
        res.json({ success: true, count: items.length });
    } catch (err) {
        if (err.code === 'SQLITE_BUSY') {
            return res.status(503).json({ error: 'Database is busy, please try again' });
        }
        log.error('Error bulk hide:', err);
        res.status(500).json({ error: 'Failed' });
    }
});

// Bulk Show
router.post('/show/bulk', async (req, res) => {
    try {
        const { items } = req.body;
        if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });

        const db = getDb();

        // Prepare statements once
        const showCat = db.prepare('UPDATE categories SET is_hidden = 0 WHERE source_id = ? AND type = ? AND category_id = ?');
        const showItem = db.prepare('UPDATE playlist_items SET is_hidden = 0 WHERE source_id = ? AND type = ? AND item_id = ?');

        // Cascading statements (show all children of a category)
        const showCatChildren = db.prepare('UPDATE playlist_items SET is_hidden = 0 WHERE source_id = ? AND type = ? AND category_id = ?');

        const runBulk = db.transaction((list) => {
            for (const item of list) {
                const mapping = mapItemType(item.itemType);
                if (mapping) {
                    if (mapping.table === 'categories') {
                        // Show the category
                        showCat.run(item.sourceId, mapping.type, item.itemId);
                        // Cascade to children
                        showCatChildren.run(item.sourceId, mapping.type, item.itemId);
                    } else {
                        // Show individual item
                        showItem.run(item.sourceId, mapping.type, item.itemId);
                    }
                }
            }
        });

        runBulk(items);
        clearRecentCache();
        res.json({ success: true, count: items.length });
    } catch (err) {
        if (err.code === 'SQLITE_BUSY') {
            return res.status(503).json({ error: 'Database is busy, please try again' });
        }
        log.error('Error bulk show:', err);
        res.status(500).json({ error: 'Failed' });
    }
});

// Show ALL items for a source (single SQL statement - much faster than bulk)
router.post('/show/all', async (req, res) => {
    try {
        const { sourceId, contentType } = req.body;
        if (!sourceId) return res.status(400).json({ error: 'sourceId required' });

        const db = getDb();
        let catCount = 0;
        let itemCount = 0;

        // Determine which types to update based on contentType
        const types = contentType === 'movies' ? ['movie']
            : contentType === 'series' ? ['series']
                : ['live']; // default to channels

        for (const type of types) {
            const catResult = db.prepare(`UPDATE categories SET is_hidden = 0 WHERE source_id = ? AND type = ?`).run(sourceId, type);
            const itemResult = db.prepare(`UPDATE playlist_items SET is_hidden = 0 WHERE source_id = ? AND type = ?`).run(sourceId, type);
            catCount += catResult.changes;
            itemCount += itemResult.changes;
        }

        log.debug(`[Channels] Show all for source ${sourceId} (${contentType}): ${catCount} categories, ${itemCount} items`);
        clearRecentCache();
        res.json({ success: true, categoriesUpdated: catCount, itemsUpdated: itemCount });
    } catch (err) {
        log.error('Error show all:', err);
        res.status(500).json({ error: 'Failed to show all' });
    }
});

// Hide ALL items for a source (single SQL statement - much faster than bulk)
router.post('/hide/all', async (req, res) => {
    try {
        const { sourceId, contentType } = req.body;
        if (!sourceId) return res.status(400).json({ error: 'sourceId required' });

        const db = getDb();
        let catCount = 0;
        let itemCount = 0;

        // Determine which types to update based on contentType
        const types = contentType === 'movies' ? ['movie']
            : contentType === 'series' ? ['series']
                : ['live']; // default to channels

        for (const type of types) {
            const catResult = db.prepare(`UPDATE categories SET is_hidden = 1 WHERE source_id = ? AND type = ?`).run(sourceId, type);
            const itemResult = db.prepare(`UPDATE playlist_items SET is_hidden = 1 WHERE source_id = ? AND type = ?`).run(sourceId, type);
            catCount += catResult.changes;
            itemCount += itemResult.changes;
        }

        log.debug(`[Channels] Hide all for source ${sourceId} (${contentType}): ${catCount} categories, ${itemCount} items`);
        clearRecentCache();
        res.json({ success: true, categoriesUpdated: catCount, itemsUpdated: itemCount });
    } catch (err) {
        log.error('Error hide all:', err);
        res.status(500).json({ error: 'Failed to hide all' });
    }
});

// Get recent movies or series
router.get('/recent', async (req, res) => {
    try {
        const { type, limit = 12 } = req.query;
        if (!type || (type !== 'movie' && type !== 'series')) {
            return res.status(400).json({ error: 'Valid type (movie or series) is required' });
        }

        const parsedLimit = parseInt(limit);
        const cached = getRecentCached(type, parsedLimit);
        if (cached) return res.json(cached);

        const formatted = queryRecent(type, parsedLimit);
        setRecentCached(type, parsedLimit, formatted);
        res.json(formatted);
    } catch (err) {
        log.error(`Error getting recent ${req.query.type}:`, err);
        res.status(500).json({ error: 'Failed to get recent items' });
    }
});

module.exports = router;
module.exports.clearRecentCache = clearRecentCache;
module.exports.warmRecentCache = warmRecentCache;

