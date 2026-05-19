require('../fetch-patch.cjs'); // Route all fetch() through VPN proxy + scrub proxy-revealing headers
const log = require('./utils/logger');
const express = require('express');
require('dotenv').config();
const path = require('path');
const passport = require('passport');
const syncService = require('./services/syncService');

// Initialize database
require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy headers (X-Forwarded-Proto, X-Forwarded-For, etc.)
// Required for correct protocol detection behind reverse proxies (nginx, Caddy, etc.)
app.set('trust proxy', true);

// Middleware
app.use(express.json({ limit: '50mb' }));

// Log all API requests at DEBUG level — method, path, status, time, payload size
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const ms = Date.now() - start;
        const bytes = res.getHeader('content-length');
        const size = bytes ? `${(bytes / 1024).toFixed(1)}kb` : '-';
        log.debug(`[API] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms ${size}`);
    });
    next();
});

// Initialize Passport
const session = require('express-session');
const SqliteSessionStore = require('./services/sessionStore');
app.use(session({
    store: new SqliteSessionStore(),
    secret: process.env.JWT_SECRET || 'keyboard cat',
    resave: false,
    saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

app.use(express.static(path.join(__dirname, '..', 'public')));

// FFMPEG Configuration (optional - for transcoding support)
// Priority: 1. System FFmpeg (better Docker DNS support), 2. ffmpeg-static npm package
const { execSync } = require('child_process');

function findFFmpeg() {
    // Try system FFmpeg first (better Docker compatibility)
    try {
        execSync('ffmpeg -version', { stdio: 'ignore' });
        log.info('FFmpeg binary configured at: ffmpeg (system)');
        return 'ffmpeg';
    } catch (e) {
        // System FFmpeg not found, try ffmpeg-static
    }

    // Try ffmpeg-static npm package
    try {
        let ffmpegPath = require('ffmpeg-static');
        // In packaged Electron apps, ffmpeg-static returns path inside .asar archive
        // but the binary is actually unpacked to app.asar.unpacked
        if (ffmpegPath && ffmpegPath.includes('app.asar')) {
            ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
        }
        log.info('FFmpeg binary configured at:', ffmpegPath);
        return ffmpegPath;
    } catch (err) {
        log.warn('FFmpeg not available - transcoding/remuxing will be disabled.');
        log.warn('Install FFmpeg via your package manager or npm install ffmpeg-static');
        return null;
    }
}

function findFFprobe() {
    // Try system ffprobe first
    try {
        execSync('ffprobe -version', { stdio: 'ignore' });
        log.info('FFprobe binary configured at: ffprobe (system)');
        return 'ffprobe';
    } catch (e) {
        // Not found in system
    }

    // Try @ffprobe-installer/ffprobe package
    try {
        const ffprobePath = require('@ffprobe-installer/ffprobe').path;
        if (ffprobePath) {
            log.info('FFprobe binary configured at:', ffprobePath);
            return ffprobePath;
        }
    } catch (err) {
        // Package not available
    }

    log.warn('FFprobe not available - auto transcode will fallback to always transcode');
    return null;
}

app.locals.ffmpegPath = findFFmpeg();
app.locals.ffprobePath = findFFprobe();

// Dynamic services loader - collects exports from files in ./services
const fs = require('fs');
const services = {};
try {
    const servicesDir = path.join(__dirname, 'services');
    const serviceFiles = fs.readdirSync(servicesDir).filter(f => f.endsWith('.js'));
    for (const file of serviceFiles) {
        const name = file.replace(/\.js$/, '');
        try {
            services[name] = require(path.join(servicesDir, file));
        } catch (e) {
            log.warn(`Failed to load service ${file}:`, e.message);
        }
    }
} catch (e) {
    log.warn('No services directory found or failed to read services:', e.message);
}

// Freeze services object to prevent plugins from mutating shared state
Object.freeze(services);

// Plugin loader: loads any .js file inside server/plugins and calls the
// exported function with (app, services).
// Supports both function exports and object exports with lifecycle hooks.
const loadedPlugins = [];

async function loadPlugins() {
    try {
        const pluginsDir = path.join(__dirname, 'plugins');
        if (fs.existsSync(pluginsDir)) {
            // Sort plugin files alphabetically for deterministic load order
            const pluginFiles = fs.readdirSync(pluginsDir)
                .filter(f => f.endsWith('.js'))
                .sort();

            for (const file of pluginFiles) {
                const pluginPath = path.join(pluginsDir, file);
                try {
                    const plugin = require(pluginPath);

                    // Support both function exports and object exports with lifecycle hooks
                    if (typeof plugin === 'function') {
                        // Direct function export (sync or async)
                        await plugin(app, services);
                        loadedPlugins.push({ name: file, plugin: null });
                        log.info(`✓ Loaded plugin: ${file}`);
                    } else if (plugin && typeof plugin.init === 'function') {
                        // Object export with init/shutdown lifecycle
                        await plugin.init(app, services);
                        loadedPlugins.push({ name: file, plugin });
                        log.info(`✓ Loaded plugin: ${file} (with lifecycle hooks)`);
                    } else {
                        log.warn(`⚠ Plugin ${file} does not export a function or object with init(), skipping.`);
                    }
                } catch (err) {
                    log.error(`✗ Failed to load plugin ${file}:`, err);
                }
            }
        }
    } catch (err) {
        log.warn('Plugin loader failed:', err.message);
    }
}

// Graceful shutdown handler for plugins with shutdown hooks
process.on('SIGTERM', async () => {
    log.info('SIGTERM received, shutting down plugins...');
    for (const { name, plugin } of loadedPlugins) {
        if (plugin && typeof plugin.shutdown === 'function') {
            try {
                await plugin.shutdown();
                log.info(`✓ Shutdown plugin: ${name}`);
            } catch (err) {
                log.error(`✗ Error shutting down plugin ${name}:`, err);
            }
        }
    }
    process.exit(0);
});

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/sources', require('./routes/sources'));
const proxyRouter = require('./routes/proxy');
app.use('/api/proxy', proxyRouter);
const channelsRouter = require('./routes/channels');
app.use('/api/channels', channelsRouter);
app.use('/api/favorites', require('./routes/favorites'));
app.use('/api/transcode', require('./routes/transcode'));
app.use('/api/remux', require('./routes/remux'));
app.use('/api/probe', require('./routes/probe'));
app.use('/api/subtitle', require('./routes/subtitle'));
app.use('/api/settings', require('./routes/settings'));
const historyRouter = require('./routes/history');
app.use('/api/history', historyRouter);

// Version endpoint
app.get('/api/version', (req, res) => {
    const pkg = require('../package.json');
    res.json({ version: pkg.version });
});

// SPA fallback - serve index.html for all non-API routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Error handling
app.use((err, req, res, next) => {
    log.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, async () => {
    log.info(`NodeCast TV server running on http://localhost:${PORT}`);

    // Load plugins
    await loadPlugins().catch(err => {
        log.error('Plugin initialization failed:', err);
    });

    // Warm DB cache from existing data immediately (before sync)
    proxyRouter.warmDbCache().catch(err => log.warn('[Cache] Startup warm failed:', err.message));
    channelsRouter.warmRecentCache();
    historyRouter.warmChannelsCache();

    // Re-warm DB cache after every sync cycle (timer-driven or manual)
    syncService.onSyncComplete(() => {
        proxyRouter.warmDbCache();
        channelsRouter.warmRecentCache();
        historyRouter.warmChannelsCache();
    });

    // Start sync timer after server settles.
    // startSyncTimer() will sync immediately if overdue, or resume the countdown
    // from the last completed sync — no unconditional full sync on every restart.
    setTimeout(async () => {
        await syncService.startSyncTimer().catch(log.error);

        // Detect hardware acceleration capabilities
        try {
            const hwDetect = require('./services/hwDetect');
            await hwDetect.detect();
        } catch (err) {
            log.warn('Hardware detection failed:', err.message);
        }
    }, 5000);
});
