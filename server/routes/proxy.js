const log = require('../utils/logger');
const express = require('express');
const router = express.Router();
const { sources } = require('../db');
const { getDb } = require('../db/sqlite'); // Import SQLite
const xtreamApi = require('../services/xtreamApi');
const epgParser = require('../services/epgParser');
const cache = require('../services/cache');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { Readable } = require('stream');
const { promisify } = require('util');
const { gzip } = require('zlib');
const gzipAsync = promisify(gzip);

// Default cache max age in hours
const DEFAULT_MAX_AGE_HOURS = 24;

// DB cache lives for 25h — data only changes on 24h sync cycles.
// Cache is refreshed immediately after each sync via warmDbCache().
const DB_CACHE_TTL = 25 * 60 * 60 * 1000; // 25 hours

// Helper to get formatted category list from DB
function getCategoriesFromDb(sourceId, type, includeHidden = false) {
    const db = getDb();
    let query = `
        SELECT category_id, name as category_name, parent_id 
        FROM categories 
        WHERE source_id = ? AND type = ?
    `;
    if (!includeHidden) {
        query += ` AND is_hidden = 0`;
    }
    query += ` ORDER BY name ASC`;
    const cats = db.prepare(query).all(sourceId, type);
    return cats;
}

// Helper to get formatted streams from DB
function getStreamsFromDb(sourceId, type, categoryId = null, includeHidden = false) {
    const db = getDb();
    let query = `
        SELECT item_id, name, stream_icon, added_at, rating, container_extension, year, category_id, data
        FROM playlist_items 
        WHERE source_id = ? AND type = ?
    `;
    if (!includeHidden) {
        query += ` AND is_hidden = 0`;
    }
    const params = [sourceId, type];

    if (categoryId) {
        query += ` AND category_id = ?`;
        params.push(categoryId);
    }

    // Default sorting
    // query += ` ORDER BY name ASC`; // Sorting usually handled by client

    const items = db.prepare(query).all(...params);

    // Map to Xtream format
    return items.map(item => {
        const data = JSON.parse(item.data || '{}');
        // Override with our local fields if needed, or just return the mixed object
        // We should ensure critical fields are present
        return {
            ...data,
            stream_id: item.item_id, // ensure ID matches what client expects
            series_id: type === 'series' ? item.item_id : undefined,
            name: item.name,
            stream_icon: item.stream_icon,
            cover: item.stream_icon, // series/vod often use cover
            added: item.added_at,
            rating: item.rating,
            container_extension: item.container_extension,
            category_id: item.category_id,
            // Normalize EPG channel ID: Xtream uses epg_channel_id, M3U uses tvgId
            epg_channel_id: data.epg_channel_id || data.tvgId || null
        };
    });
}


// --- Xtream Codes Proxy API --- //

// Login / Authenticate
router.get('/xtream/:sourceId', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source || source.type !== 'xtream') return res.status(404).send('Source not found');

        // Proxy auth check to upstream to ensure credentials are still valid

        const cached = cache.get('xtream', source.id, 'auth', 300000);
        if (cached) { log.debug(`[Cache] hit ${cacheKey}`); return res.json(cached); }

        const api = xtreamApi.createFromSource(source);
        const data = await api.authenticate();
        cache.set('xtream', source.id, 'auth', data);
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Upstream error', details: err.message });
    }
});

// Live Categories
router.get('/xtream/:sourceId/live_categories', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const includeHidden = req.query.includeHidden === 'true';
        const cacheKey = `db_live_cat_${includeHidden}`;
        const cached = cache.get('xtream', sourceId, cacheKey, DB_CACHE_TTL);
        if (cached) { log.debug(`[Cache] hit ${cacheKey}`); return res.json(cached); }
        const cats = getCategoriesFromDb(sourceId, 'live', includeHidden);
        cache.set('xtream', sourceId, cacheKey, cats);
        res.json(cats);
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Live Streams
router.get('/xtream/:sourceId/live_streams', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const categoryId = req.query.category_id;
        const includeHidden = req.query.includeHidden === 'true';
        if (!categoryId) {
            const gz = STREAM_GZIP_CACHE.get(`${sourceId}_db_live_${includeHidden}`);
            if (gz && (Date.now() - gz.ts) < DB_CACHE_TTL && req.headers['accept-encoding']?.includes('gzip')) {
                log.debug(`[Cache] hit db_live_streams_all_${includeHidden} (gz)`);
                res.set('Content-Encoding', 'gzip').set('Content-Type', 'application/json').set('Content-Length', gz.gz.length);
                return res.end(gz.gz);
            }
        }
        const cacheKey = `db_live_streams_${categoryId || 'all'}_${includeHidden}`;
        const cached = cache.get('xtream', sourceId, cacheKey, DB_CACHE_TTL);
        if (cached) { log.debug(`[Cache] hit ${cacheKey}`); return res.json(cached); }
        const streams = getStreamsFromDb(sourceId, 'live', categoryId, includeHidden);
        cache.set('xtream', sourceId, cacheKey, streams);
        res.json(streams);
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// VOD Categories
router.get('/xtream/:sourceId/vod_categories', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const includeHidden = req.query.includeHidden === 'true';
        const cacheKey = `db_vod_cat_${includeHidden}`;
        const cached = cache.get('xtream', sourceId, cacheKey, DB_CACHE_TTL);
        if (cached) { log.debug(`[Cache] hit ${cacheKey}`); return res.json(cached); }
        const cats = getCategoriesFromDb(sourceId, 'movie', includeHidden);
        cache.set('xtream', sourceId, cacheKey, cats);
        res.json(cats);
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// VOD Streams
router.get('/xtream/:sourceId/vod_streams', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const categoryId = req.query.category_id;
        const includeHidden = req.query.includeHidden === 'true';
        if (!categoryId) {
            const gz = STREAM_GZIP_CACHE.get(`${sourceId}_db_vod_${includeHidden}`);
            if (gz && (Date.now() - gz.ts) < DB_CACHE_TTL && req.headers['accept-encoding']?.includes('gzip')) {
                log.debug(`[Cache] hit db_vod_streams_all_${includeHidden} (gz)`);
                res.set('Content-Encoding', 'gzip').set('Content-Type', 'application/json').set('Content-Length', gz.gz.length);
                return res.end(gz.gz);
            }
        }
        const cacheKey = `db_vod_streams_${categoryId || 'all'}_${includeHidden}`;
        const cached = cache.get('xtream', sourceId, cacheKey, DB_CACHE_TTL);
        if (cached) { log.debug(`[Cache] hit ${cacheKey}`); return res.json(cached); }
        const streams = getStreamsFromDb(sourceId, 'movie', categoryId, includeHidden);
        cache.set('xtream', sourceId, cacheKey, streams);
        res.json(streams);
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Series Categories
router.get('/xtream/:sourceId/series_categories', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const includeHidden = req.query.includeHidden === 'true';
        const cacheKey = `db_series_cat_${includeHidden}`;
        const cached = cache.get('xtream', sourceId, cacheKey, DB_CACHE_TTL);
        if (cached) { log.debug(`[Cache] hit ${cacheKey}`); return res.json(cached); }
        const cats = getCategoriesFromDb(sourceId, 'series', includeHidden);
        cache.set('xtream', sourceId, cacheKey, cats);
        res.json(cats);
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Series
router.get('/xtream/:sourceId/series', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const categoryId = req.query.category_id;
        const includeHidden = req.query.includeHidden === 'true';
        if (!categoryId) {
            const gz = STREAM_GZIP_CACHE.get(`${sourceId}_db_series_${includeHidden}`);
            if (gz && (Date.now() - gz.ts) < DB_CACHE_TTL && req.headers['accept-encoding']?.includes('gzip')) {
                log.debug(`[Cache] hit db_series_streams_all_${includeHidden} (gz)`);
                res.set('Content-Encoding', 'gzip').set('Content-Type', 'application/json').set('Content-Length', gz.gz.length);
                return res.end(gz.gz);
            }
        }
        const cacheKey = `db_series_streams_${categoryId || 'all'}_${includeHidden}`;
        const cached = cache.get('xtream', sourceId, cacheKey, DB_CACHE_TTL);
        if (cached) { log.debug(`[Cache] hit ${cacheKey}`); return res.json(cached); }
        const streams = getStreamsFromDb(sourceId, 'series', categoryId, includeHidden);
        cache.set('xtream', sourceId, cacheKey, streams);
        res.json(streams);
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Series Info (Episodes)
// Proxy series info request
router.get('/xtream/:sourceId/series_info', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source) return res.status(404).send('Source not found');

        const seriesId = req.query.series_id;
        if (!seriesId) return res.status(400).send('series_id required');

        const cacheKey = `series_info_${seriesId}`;
        const cached = cache.get('xtream', source.id, cacheKey, 3600000);
        if (cached) { log.debug(`[Cache] hit ${cacheKey}`); return res.json(cached); }

        const api = xtreamApi.createFromSource(source);
        const data = await api.getSeriesInfo(seriesId);
        cache.set('xtream', source.id, cacheKey, data);
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Upstream error', details: err.message });
    }
});

// VOD Info
router.get('/xtream/:sourceId/vod_info', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source) return res.status(404).send('Source not found');

        const vodId = req.query.vod_id;
        if (!vodId) return res.status(400).send('vod_id required');

        const cacheKey = `vod_info_${vodId}`;
        const cached = cache.get('xtream', source.id, cacheKey, 3600000);
        if (cached) { log.debug(`[Cache] hit ${cacheKey}`); return res.json(cached); }

        const api = xtreamApi.createFromSource(source);
        const data = await api.getVodInfo(vodId);
        cache.set('xtream', source.id, cacheKey, data);
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Upstream error', details: err.message });
    }
});

// Get Stream URL for playback
// Returns the direct stream URL for a given stream ID
router.get('/xtream/:sourceId/stream/:streamId/:type', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source || source.type !== 'xtream') {
            return res.status(404).json({ error: 'Xtream source not found' });
        }

        const streamId = req.params.streamId;
        const type = req.params.type || 'live';
        const container = req.query.container || 'm3u8';

        // Construct the Xtream stream URL
        // Format: http://server:port/live/username/password/streamId.container (for live)
        // Format: http://server:port/movie/username/password/streamId.container (for movie)
        // Format: http://server:port/series/username/password/streamId.container (for series)

        let streamUrl;
        const baseUrl = source.url.replace(/\/$/, ''); // Remove trailing slash

        if (type === 'live') {
            streamUrl = `${baseUrl}/live/${source.username}/${source.password}/${streamId}.${container}`;
        } else if (type === 'movie') {
            streamUrl = `${baseUrl}/movie/${source.username}/${source.password}/${streamId}.${container}`;
        } else if (type === 'series') {
            streamUrl = `${baseUrl}/series/${source.username}/${source.password}/${streamId}.${container}`;
        } else {
            return res.status(400).json({ error: 'Invalid stream type' });
        }

        res.json({ url: streamUrl });
    } catch (err) {
        log.error('Error getting stream URL:', err);
        res.status(500).json({ error: 'Failed to get stream URL' });
    }
});


// Helper to build the EPG response object from SQLite (shared by route + cache warm)
function buildEpgResponse(sourceId) {
    const db = getDb();
    // 2h past so "currently airing" shows correctly; 24h future for the guide
    const windowStart = Date.now() - (2 * 60 * 60 * 1000);
    const windowEnd   = Date.now() + (24 * 60 * 60 * 1000);

    const programs = db.prepare(`
        SELECT channel_id as channelId, start_time, end_time, title, description
        FROM epg_programs
        WHERE source_id = ? AND end_time > ? AND start_time < ?
    `).all(sourceId, windowStart, windowEnd);

    const formattedPrograms = programs.map(p => ({
        channelId: p.channelId,
        start: new Date(p.start_time).toISOString(),
        stop:  new Date(p.end_time).toISOString(),
        title: p.title,
        description: p.description
    }));

    const storedChannels = db.prepare(`
        SELECT item_id as id, name, stream_icon as icon, data
        FROM playlist_items
        WHERE source_id = ? AND type = 'epg_channel'
    `).all(sourceId);

    const epgChannels = storedChannels.length > 0
        ? storedChannels
        : [...new Set(programs.map(p => p.channelId))].map(id => ({ id, name: id }));

    return { channels: epgChannels, programmes: formattedPrograms };
}

// --- Other Proxy Routes --- //

// M3U Playlist 
// (For M3U sources, we now have data in DB. We can reconstruct M3U or return JSON)
// Frontend ChannelList.js for M3U sources calls `API.proxy.m3u.get(sourceId)`
// which points here. It expects { channels, groups }.
router.get('/m3u/:sourceId', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);
        const includeHidden = req.query.includeHidden === 'true';

        // Fetch from DB
        const channels = getStreamsFromDb(sourceId, 'live', null, includeHidden);
        const groups = getCategoriesFromDb(sourceId, 'live', includeHidden);

        // Format for frontend helper
        // ChannelList expects:
        // { 
        //   channels: [ { id, name, groupTitle, url, tvgLogo, ... } ], 
        //   groups: [ { id, name, channelCount } ] 
        // }
        // Note: DB `live` items from M3U sync have `category_id` as their group name usually.

        const reformattedChannels = channels.map(c => ({
            ...c,
            id: c.stream_id,
            groupTitle: c.category_id || 'Uncategorized',
            url: c.stream_url || c.url,
            tvgLogo: c.stream_icon
        }));

        const reformattedGroups = groups.map(g => ({
            id: g.category_id,
            name: g.category_name,
            channelCount: 0 // Frontend calculates this or we can
        }));

        // Add implicit groups check?
        // The frontend M3U parser generates groups from the channels if explicit groups missing.
        // Our SyncService `saveCategories` handles explicit groups.

        res.json({ channels: reformattedChannels, groups: reformattedGroups });

    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Pre-serialized + pre-gzip'd cache for large stream list endpoints
// Key: `${sourceId}_${cachePrefix}_${includeHidden}` e.g. "6_db_vod_false"
const STREAM_GZIP_CACHE = new Map();

// EPG — pre-serialize + pre-compress to avoid per-request CPU overhead on a 60MB response
const EPG_JSON_CACHE = new Map(); // sourceId → { json: string, gz: Buffer, ts: number }

router.get('/epg/:sourceId', async (req, res) => {
    try {
        const sourceId = parseInt(req.params.sourceId);

        const entry = EPG_JSON_CACHE.get(sourceId);
        if (entry && (Date.now() - entry.ts) < DB_CACHE_TTL) {
            const etag = `"${entry.ts}"`;
            if (req.headers['if-none-match'] === etag) {
                return res.status(304).end();
            }
            log.debug(`[Cache] hit db_epg_data`);
            res.set('ETag', etag);
            res.set('Cache-Control', 'public, max-age=3600');
            const acceptsGzip = req.headers['accept-encoding']?.includes('gzip');
            if (acceptsGzip && entry.gz) {
                res.set('Content-Encoding', 'gzip');
                res.set('Content-Type', 'application/json');
                res.set('Content-Length', entry.gz.length);
                return res.end(entry.gz);
            }
            res.set('Content-Type', 'application/json');
            return res.end(entry.json);
        }

        const result = buildEpgResponse(sourceId);
        const json = JSON.stringify(result);
        const gz = await gzipAsync(Buffer.from(json));
        const ts = Date.now();
        EPG_JSON_CACHE.set(sourceId, { json, gz, ts });

        const etag = `"${ts}"`;
        res.set('ETag', etag);
        res.set('Cache-Control', 'public, max-age=3600');
        const acceptsGzip = req.headers['accept-encoding']?.includes('gzip');
        if (acceptsGzip) {
            res.set('Content-Encoding', 'gzip');
            res.set('Content-Type', 'application/json');
            res.set('Content-Length', gz.length);
            return res.end(gz);
        }
        res.set('Content-Type', 'application/json');
        res.end(json);
    } catch (err) {
        log.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Clear cache (kept for compatibility)
router.delete('/cache/:sourceId', (req, res) => {
    const sourceId = req.params.sourceId;
    cache.clearSource(sourceId);
    res.json({ success: true });
});



/**
 * Proxy Xtream API calls
 * GET /api/proxy/xtream/:sourceId/:action
 */
router.get('/xtream/:sourceId/:action', async (req, res) => {
    try {
        const sourceId = req.params.sourceId;
        const source = await sources.getById(sourceId);
        if (!source || source.type !== 'xtream') {
            return res.status(404).json({ error: 'Xtream source not found' });
        }

        const { action } = req.params;
        const { category_id, stream_id, vod_id, series_id, limit, refresh, maxAge } = req.query;
        const forceRefresh = refresh === '1';
        const maxAgeHours = parseInt(maxAge) || DEFAULT_MAX_AGE_HOURS;
        const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

        // Actions that should be cached
        const cacheableActions = [
            'live_categories', 'live_streams',
            'vod_categories', 'vod_streams',
            'series_categories', 'series'
        ];

        // Build cache key (include category_id if present)
        const cacheKey = category_id ? `${action}_${category_id}` : action;

        // Check cache for cacheable actions
        if (!forceRefresh && cacheableActions.includes(action)) {
            const cached = cache.get('xtream', sourceId, cacheKey, maxAgeMs);
            if (cached) {
                return res.json(cached);
            }
        }

        // Fetch fresh data
        const api = xtreamApi.createFromSource(source);
        let data;
        switch (action) {
            case 'auth':
                data = await api.authenticate();
                break;
            case 'live_categories':
                data = await api.getLiveCategories();
                break;
            case 'live_streams':
                data = await api.getLiveStreams(category_id);
                break;
            case 'vod_categories':
                data = await api.getVodCategories();
                break;
            case 'vod_streams':
                data = await api.getVodStreams(category_id);
                break;
            case 'vod_info':
                data = await api.getVodInfo(vod_id);
                break;
            case 'series_categories':
                data = await api.getSeriesCategories();
                break;
            case 'series':
                data = await api.getSeries(category_id);
                break;
            case 'series_info':
                data = await api.getSeriesInfo(series_id);
                break;
            case 'short_epg':
                data = await api.getShortEpg(stream_id, limit);
                break;
            default:
                return res.status(400).json({ error: 'Unknown action' });
        }

        // Cache the result for cacheable actions
        if (cacheableActions.includes(action)) {
            cache.set('xtream', sourceId, cacheKey, data);
        }

        res.json(data);
    } catch (err) {
        log.error('Xtream proxy error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Get Xtream stream URL
 * GET /api/proxy/xtream/:sourceId/stream/:streamId
 */
router.get('/xtream/:sourceId/stream/:streamId/:type?', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source || source.type !== 'xtream') {
            return res.status(404).json({ error: 'Xtream source not found' });
        }

        const api = xtreamApi.createFromSource(source);
        const { streamId, type = 'live' } = req.params;
        const { container = 'm3u8' } = req.query;

        const url = api.buildStreamUrl(streamId, type, container);
        res.json({ url });
    } catch (err) {
        log.error('Stream URL error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Fetch and parse EPG (with file-based caching)
 * GET /api/proxy/epg/:sourceId
 * Query params:
 *   - refresh=1  Force refresh, bypass cache
 *   - maxAge=N   Max cache age in hours (default 24)
 */
router.get('/epg/:sourceId', async (req, res) => {
    try {
        const sourceId = req.params.sourceId;
        const source = await sources.getById(sourceId);
        if (!source || (source.type !== 'epg' && source.type !== 'xtream')) {
            return res.status(404).json({ error: 'Valid EPG source not found' });
        }

        const forceRefresh = req.query.refresh === '1';
        const maxAgeHours = parseInt(req.query.maxAge) || DEFAULT_MAX_AGE_HOURS;
        const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

        // Check file cache (unless force refresh)
        if (!forceRefresh) {
            const cached = cache.get('epg', sourceId, 'data', maxAgeMs);
            if (cached) {
                return res.json(cached);
            }
        }

        // Fetch fresh data
        let url = source.url;
        if (source.type === 'xtream') {
            const api = xtreamApi.createFromSource(source);
            url = api.getXmltvUrl();
        }

        const data = await epgParser.fetchAndParse(url);

        // Store in file cache
        cache.set('epg', sourceId, 'data', data);

        res.json(data);
    } catch (err) {
        log.error('EPG proxy error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Clear cache for a source
 * DELETE /api/proxy/cache/:sourceId
 */
router.delete('/cache/:sourceId', (req, res) => {
    const sourceId = req.params.sourceId;
    cache.clearSource(sourceId);
    res.json({ success: true });
});

/**
 * Clear EPG cache for a source (legacy endpoint, calls clearSource)
 * DELETE /api/proxy/epg/:sourceId/cache
 */
router.delete('/epg/:sourceId/cache', (req, res) => {
    const sourceId = req.params.sourceId;
    cache.clear('epg', sourceId, 'data');
    res.json({ success: true });
});

/**
 * Get EPG for specific channels
 * POST /api/proxy/epg/:sourceId/channels
 */
router.post('/epg/:sourceId/channels', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source || source.type !== 'epg') {
            return res.status(404).json({ error: 'EPG source not found' });
        }

        const { channelIds } = req.body;
        if (!channelIds || !Array.isArray(channelIds)) {
            return res.status(400).json({ error: 'channelIds array required' });
        }

        const data = await epgParser.fetchAndParse(source.url);

        // Filter programmes for requested channels
        const result = {};
        for (const channelId of channelIds) {
            result[channelId] = epgParser.getCurrentAndUpcoming(data.programmes, channelId);
        }

        res.json(result);
    } catch (err) {
        log.error('EPG channels error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Proxy stream for playback
 * This handles CORS for streams that don't allow cross-origin
 * Supports HTTP Range requests for video seeking
 */
router.get('/stream', async (req, res) => {
    const maxRetries = 2;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            let { url } = req.query;
            if (!url) {
                return res.status(400).json({ error: 'URL required' });
            }
            const elapsed = log.timer();

            // Forward some headers to be more "transparent" back to the origin
            // Pluto TV uses multiple domains for content delivery
            const plutoDomains = ['pluto.tv', 'pluto.io', 'plutotv.net', 'siloh.pluto.tv', 'service-stitcher'];
            const isPluto = plutoDomains.some(domain => url.includes(domain));

            const headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                // Using https and matching the origin of the request
                'Origin': isPluto ? 'https://pluto.tv' : new URL(url).origin,
                'Referer': isPluto ? 'https://pluto.tv/' : new URL(url).origin + '/'
            };

            // Forward Range header for video seeking support
            const rangeHeader = req.get('range');
            if (rangeHeader) {
                headers['Range'] = rangeHeader;
            }

            const response = await fetch(url, { headers });

            // Retry on 5xx errors (transient upstream issues)
            if (response.status >= 500 && attempt < maxRetries) {
                log.debug(`[Proxy] Upstream 5xx error (attempt ${attempt}/${maxRetries}), retrying in 500ms...`);
                await new Promise(r => setTimeout(r, 500));
                continue;
            }

            if (!response.ok) {
                log.error(`Upstream error for ${url.substring(0, 80)}...: ${response.status} ${response.statusText}`);
                if (response.status === 403) {
                    const errorBody = await response.text().catch(() => 'N/A');
                    log.error(`403 Response body: ${errorBody.substring(0, 200)}`);
                }
                return res.status(response.status).send(`Failed to fetch stream: ${response.statusText}`);
            }

            const contentType = response.headers.get('content-type') || '';
            res.set('Access-Control-Allow-Origin', '*');

            // Forward range-related headers for video seeking support
            const contentLength = response.headers.get('content-length');
            const contentRange = response.headers.get('content-range');
            const acceptRanges = response.headers.get('accept-ranges');

            if (contentLength) {
                res.set('Content-Length', contentLength);
            }
            if (contentRange) {
                res.set('Content-Range', contentRange);
            }
            if (acceptRanges) {
                res.set('Accept-Ranges', acceptRanges);
            } else if (contentLength && !contentRange) {
                // If server supports content-length but didn't explicitly state accept-ranges,
                // we can safely assume it supports byte ranges
                res.set('Accept-Ranges', 'bytes');
            }

            // Set status code (206 for partial content when range request was made)
            res.status(response.status);

            // Create an async iterator for the response body
            const iterator = response.body[Symbol.asyncIterator]();
            const first = await iterator.next();

            if (first.done) {
                res.set('Content-Type', contentType || 'application/octet-stream');
                return res.end();
            }

            const firstChunk = Buffer.from(first.value);

            // Peek at first bytes to check for HLS manifest ({ #EXTM3U })
            const textPrefix = firstChunk.subarray(0, 7).toString('utf8');
            const contentLooksLikeHls = textPrefix === '#EXTM3U';

            if (contentLooksLikeHls) {
                // HLS Manifest: We must read the WHOLE manifest to rewrite it
                const chunks = [firstChunk];

                // Consume the rest of the stream
                let result = await iterator.next();
                while (!result.done) {
                    chunks.push(Buffer.from(result.value));
                    result = await iterator.next();
                }

                const buffer = Buffer.concat(chunks);
                const finalUrl = response.url || url;
                log.debug(`[Proxy] Processing HLS manifest from: ${finalUrl.substring(0, 80)}...`);
                res.set('Content-Type', 'application/vnd.apple.mpegurl');

                let manifest = buffer.toString('utf-8');

                const finalUrlObj = new URL(finalUrl);
                const baseUrl = finalUrlObj.origin + finalUrlObj.pathname.substring(0, finalUrlObj.pathname.lastIndexOf('/') + 1);

                manifest = manifest.split('\n').map(line => {
                    const trimmed = line.trim();
                    if (trimmed === '' || trimmed.startsWith('#')) {
                        // Handle both URI="..." and URI='...' formats
                        if (trimmed.includes('URI=')) {
                            // Replace both double and single quoted URIs
                            return line.replace(/URI=["']([^"']+)["']/g, (match, p1) => {
                                try {
                                    const absoluteUrl = new URL(p1, baseUrl).href;
                                    return `URI="${req.protocol}://${req.get('host')}${req.baseUrl}/stream?url=${encodeURIComponent(absoluteUrl)}"`;
                                } catch (e) {
                                    return match;
                                }
                            });
                        }
                        return line;
                    }

                    // Stream URL handling
                    try {
                        let absoluteUrl;
                        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
                            absoluteUrl = trimmed;
                        } else {
                            absoluteUrl = new URL(trimmed, baseUrl).href;
                        }
                        return `${req.protocol}://${req.get('host')}${req.baseUrl}/stream?url=${encodeURIComponent(absoluteUrl)}`;
                    } catch (e) { return line; }
                }).join('\n');

                return res.send(manifest);
            }

            // Binary content (Video Segment or Key): Collect and send
            log.debug(`[Proxy] Serving binary content (${contentType})`);
            res.set('Content-Type', contentType || 'application/octet-stream');

            // For small files (like encryption keys), collect all data and send at once
            // This ensures proper Content-Length and response completion
            const chunks = [firstChunk];
            let result = await iterator.next();
            while (!result.done) {
                chunks.push(Buffer.from(result.value));
                result = await iterator.next();
            }
            const fullContent = Buffer.concat(chunks);

            // Set Content-Length for proper client handling
            res.set('Content-Length', fullContent.length);
            res.send(fullContent);
            log.debug(`[Proxy] ${req.method} ${req.path} completed in ${elapsed()}ms`);
            return; // Success - exit the retry loop

        } catch (err) {
            lastError = err;
            log.error(`Stream proxy error (attempt ${attempt}/${maxRetries}):`, err.message);
            if (attempt < maxRetries) {
                log.debug('[Proxy] Retrying after error...');
                await new Promise(r => setTimeout(r, 500));
                continue;
            }
        }
    }

    // All retries failed
    if (!res.headersSent) {
        res.status(500).json({ error: lastError?.message || 'Stream proxy failed after retries' });
    }
});

/**
 * Proxy images (channel logos, posters)
 * Fixes mixed content errors when loading HTTP images on HTTPS pages
 * GET /api/proxy/image?url=...
 */
router.get('/image', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) {
            return res.status(400).json({ error: 'URL required' });
        }

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/*,*/*;q=0.8'
            }
        });

        if (!response.ok) {
            return res.status(response.status).send('Failed to fetch image');
        }

        const contentType = response.headers.get('content-type') || 'image/png';
        res.set('Content-Type', contentType);
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours

        // Efficiently pipe the response body
        if (response.body) {
            // response.body is an AsyncIterable in standard fetch/undici
            // Readable.from converts it to a Node.js Readable stream
            const stream = Readable.from(response.body);
            stream.pipe(res);
        } else {
            res.end();
        }

    } catch (err) {
        log.error('Image proxy error:', err.message);
        res.status(500).send('Image proxy error');
    }
});

/**
 * Pre-populate DB cache for all enabled sources.
 * Fetches each type once (all rows including hidden), maps in one pass,
 * then partitions into visible/all — avoids running 121k-row movie query twice.
 * Movie and series warm in parallel (interleaved via setImmediate yields) so
 * series (19k rows) completes ~4x sooner instead of waiting behind movies (121k rows).
 */
async function warmOneType(sid, dbType, cachePrefix, db) {
    const elapsed = log.timer();
    const isSeries = dbType === 'series';

    const rawCats = db.prepare(`
        SELECT category_id, name as category_name, parent_id, is_hidden
        FROM categories WHERE source_id = ? AND type = ? ORDER BY name ASC
    `).all(sid, dbType);
    const allCats = rawCats.map(({ is_hidden, ...c }) => c);
    const visCats = rawCats.filter(c => !c.is_hidden).map(({ is_hidden, ...c }) => c);
    cache.set('xtream', sid, `${cachePrefix}_cat_false`, visCats);
    cache.set('xtream', sid, `${cachePrefix}_cat_true`,  allCats);

    const stmt = db.prepare(`
        SELECT item_id, name, stream_icon, added_at, rating,
               container_extension, year, category_id, data, is_hidden
        FROM playlist_items WHERE source_id = ? AND type = ?
    `);

    const allStreams = [];
    let chunk = [];
    for (const item of stmt.iterate(sid, dbType)) {
        const data = JSON.parse(item.data || '{}');
        chunk.push({
            ...data,
            stream_id: item.item_id,
            series_id: isSeries ? item.item_id : undefined,
            name: item.name,
            stream_icon: item.stream_icon,
            cover: item.stream_icon,
            added: item.added_at,
            rating: item.rating,
            container_extension: item.container_extension,
            category_id: item.category_id,
            epg_channel_id: data.epg_channel_id || data.tvgId || null,
            _h: item.is_hidden
        });
        if (chunk.length >= 5000) {
            allStreams.push(...chunk);
            chunk = [];
            await new Promise(r => setImmediate(r));
        }
    }
    allStreams.push(...chunk);

    const hasHidden = allStreams.some(s => s._h);
    const visStreams = hasHidden ? allStreams.filter(s => !s._h).map(({ _h, ...s }) => s) : allStreams.map(({ _h, ...s }) => s);
    const allStreamsMapped = hasHidden ? allStreams.map(({ _h, ...s }) => s) : visStreams;
    cache.set('xtream', sid, `${cachePrefix}_streams_all_false`, visStreams);
    cache.set('xtream', sid, `${cachePrefix}_streams_all_true`,  allStreamsMapped);

    const gzVis = await gzipAsync(Buffer.from(JSON.stringify(visStreams)));
    const ts = Date.now();
    STREAM_GZIP_CACHE.set(`${sid}_${cachePrefix}_false`, { gz: gzVis, ts });
    STREAM_GZIP_CACHE.set(`${sid}_${cachePrefix}_true`,  { gz: hasHidden ? await gzipAsync(Buffer.from(JSON.stringify(allStreamsMapped))) : gzVis, ts });
    log.debug(`[Cache] ${dbType} warmed: ${allStreams.length} items, ${(gzVis.length/1024).toFixed(0)}kb gzip in ${elapsed()}ms`);
}

async function warmDbCache() {
    try {
        const allSources = await sources.getAll();
        const enabled = allSources.filter(s => s.enabled);
        const db = getDb();

        for (const source of enabled) {
            const sid = source.id;
            // Ordered fast→slow: series (19k) before movies (121k) so the series
            // page is usable within ~5s instead of waiting behind the 11s movie pass
            await warmOneType(sid, 'live', 'db_live', db);
            await warmOneType(sid, 'series', 'db_series', db);
            await warmOneType(sid, 'movie', 'db_vod', db);
        }

        log.info(`[Cache] DB cache warmed for ${enabled.length} source(s)`);
        warmEpgCache(enabled).catch(err => log.error('[Cache] EPG warm failed:', err.message));
    } catch (err) {
        log.error('[Cache] DB cache warm failed:', err.message);
    }
}

async function warmEpgCache(enabledSources) {
    for (const source of enabledSources) {
        const sid = source.id;
        const elapsed = log.timer();
        try {
            const result = buildEpgResponse(sid);
            if (result.programmes.length === 0) continue;
            const json = JSON.stringify(result);
            const gz = await gzipAsync(Buffer.from(json));
            EPG_JSON_CACHE.set(sid, { json, gz, ts: Date.now() });
            log.info(`[Cache] EPG warmed for source ${sid}: ${result.programmes.length} programmes, ${(gz.length/1024).toFixed(0)}kb gzip in ${elapsed()}ms`);
        } catch (err) {
            log.error(`[Cache] EPG warm failed for source ${sid}:`, err.message);
        }
    }
}

module.exports = router;
module.exports.warmDbCache = warmDbCache;
