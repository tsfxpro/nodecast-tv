const log = require('../utils/logger');
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const { spawn } = require('child_process');

router.use(requireAuth);

/**
 * Probe endpoint - detects stream codecs and container
 * GET /api/probe?url=...
 * 
 * Returns:
 * {
 *   video: "h264",
 *   audio: "aac",
 *   container: "mpegts",
 *   compatible: true,
 *   needsRemux: false,
 *   needsTranscode: false
 * }
 */

// Probe cache (URL → result)
const probeCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Browser-compatible codecs
const BROWSER_VIDEO_CODECS = ['h264', 'avc', 'avc1'];
const BROWSER_AUDIO_CODECS = ['aac', 'mp3', 'opus', 'vorbis'];

/**
 * Probe stream with ffprobe
 */
function probeStream(url, ffprobePath, userAgent = null, timeout = 15000) {
    return new Promise((resolve, reject) => {
        // For HLS streams, a small probesize is enough — codec info is in the first segment
        // headers. A large probesize (5MB) keeps a live TCP connection to the provider open
        // long enough for it to count as an active session, causing 458 when the player starts.
        const isHls = url.includes('.m3u8') || url.includes('m3u8');
        const probeSize = isHls ? '500000' : '5000000';
        const analyzeDuration = isHls ? '500000' : '5000000';

        // ffprobe/libavformat only reads http_proxy (lowercase) from the environment,
        // but our compose sets HTTP_PROXY (uppercase). Pass it explicitly so ffprobe
        // routes through gluetun VPN exactly like fetch() does.
        const httpProxy =
            process.env.HTTP_PROXY || process.env.HTTPS_PROXY ||
            process.env.http_proxy || process.env.https_proxy;

        const args = [
            '-v', 'error',
            '-user_agent', userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            '-print_format', 'json',
            '-show_streams',
            '-show_format',
            '-probesize', probeSize,
            '-analyzeduration', analyzeDuration,
            url
        ];

        if (httpProxy) {
            args.unshift('-http_proxy', httpProxy);
        }

        log.debug(`[Probe] ffprobe proxy=${httpProxy || 'DIRECT'} ${args.slice(-5).join(' ')}`);
        const proc = spawn(ffprobePath, args);
        let stdout = '';
        let stderr = '';

        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            reject(new Error('Probe timeout'));
        }, timeout);

        proc.stdout.on('data', (data) => { stdout += data; });
        proc.stderr.on('data', (data) => { stderr += data; });

        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
                return;
            }
            try {
                const result = JSON.parse(stdout);
                resolve(result);
            } catch (e) {
                reject(new Error('Failed to parse ffprobe output'));
            }
        });

        proc.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

/**
 * Analyze probe result and determine compatibility
 */
function analyzeProbeResult(probeResult, url) {
    const streams = probeResult.streams || [];
    const format = probeResult.format || {};

    const videoStream = streams.find(s => s.codec_type === 'video');
    const audioStream = streams.find(s => s.codec_type === 'audio');

    const videoCodec = videoStream?.codec_name?.toLowerCase() || 'unknown';
    const audioCodec = audioStream?.codec_name?.toLowerCase() || 'unknown';
    const container = format.format_name?.toLowerCase() || 'unknown';

    // Check codec compatibility
    const videoOk = BROWSER_VIDEO_CODECS.some(c => videoCodec.includes(c));
    const audioOk = BROWSER_AUDIO_CODECS.some(c => audioCodec.includes(c));

    // Browser-safe containers
    // Note: We exclude 'webm' because ffprobe reports MKV as "matroska,webm", 
    // and H.264/AAC in MKV/WebM is not universally supported. Best to remux to MP4.
    const BROWSER_CONTAINERS = ['hls', 'mp4', 'mov'];
    const containerOk = BROWSER_CONTAINERS.some(c => container.includes(c));

    // Check if it's a raw TS stream (not HLS)
    const isRawTs = (container.includes('mpegts') || url.endsWith('.ts')) && !url.includes('.m3u8');

    // Extract subtitle tracks
    const subtitles = streams
        .filter(s => s.codec_type === 'subtitle' && s.codec_name !== 'timed_id3' && s.codec_name !== 'bin_data')
        .map(s => ({
            index: s.index,
            language: s.tags?.language || 'und',
            title: s.tags?.title || s.tags?.language || `Track ${s.index}`,
            codec: s.codec_name
        }));

    // Determine what processing is needed
    // 4. MKV files often cause OOM/decoding issues in browser fMP4 remux, 
    // so we force them to "needsTranscode" which uses HLS (more robust).
    // The frontend will still use "copy" mode if codecs are compatible.
    const isMkv = container.includes('matroska') || container.includes('webm') || url.endsWith('.mkv');

    // 1. Incompatible audio/video OR MKV -> Transcode (or HLS Copy)
    const needsTranscode = !audioOk || !videoOk || isMkv;

    // 2. Compatible audio/video but incompatible container (non-MKV) -> Remux (fMP4 pipe)
    const needsRemux = !needsTranscode && (!containerOk || isRawTs);

    const compatible = !needsTranscode && !needsRemux;

    return {
        video: videoCodec,
        audio: audioCodec,
        width: videoStream?.width || 0,
        height: videoStream?.height || 0,
        duration: parseFloat(format.duration) || 0,
        audioChannels: audioStream?.channels || 0,
        container: container,
        compatible: compatible,
        needsRemux: needsRemux,
        needsTranscode: needsTranscode,
        subtitles: subtitles
    };
}

router.get('/', async (req, res) => {
    const { url, ua } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    const ffprobePath = req.app.locals.ffprobePath;
    const cacheKey = `${url}${ua ? `|${ua}` : ''}`;

    if (!ffprobePath) {
        // No ffprobe available - assume needs transcoding to be safe
        log.warn('[Probe] FFprobe not available, assuming transcode needed');
        return res.json({
            video: 'unknown',
            audio: 'unknown',
            container: 'unknown',
            compatible: false,
            needsRemux: false,
            needsTranscode: true
        });
    }

    // Check cache
    const cached = probeCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        log.debug(`[Probe] Cache hit: ${url.substring(0, 50)}... (served from cache)`);
        return res.json(cached.result);
    }

    log.info(`[Probe] Probing: ${url.substring(0, 80)}... ${ua ? `(UA: ${ua})` : ''}`);
    const elapsed = log.timer();

    try {
        const probeResult = await probeStream(url, ffprobePath, ua);
        const analysis = analyzeProbeResult(probeResult, url);

        // Cache result
        probeCache.set(cacheKey, { result: analysis, timestamp: Date.now() });

        log.info(`[Probe] Result: video=${analysis.video}, audio=${analysis.audio}, ` +
            `container=${analysis.container}, compatible=${analysis.compatible}, ` +
            `needsRemux=${analysis.needsRemux}, needsTranscode=${analysis.needsTranscode} (${elapsed()}ms)`);

        res.json(analysis);
    } catch (err) {
        log.error('[Probe] Failed:', err.message);

        // 458 = provider concurrent-stream limit. Return a distinct error so the player
        // can stop immediately instead of launching ffmpeg sessions that will also 458.
        const isStreamLimit = err.message.includes('458') || err.message.includes('4XX Client Error');
        if (isStreamLimit) {
            return res.status(429).json({
                error: 'stream_limit',
                details: err.message
            });
        }

        // For other probe failures assume transcode needed (safe default).
        res.json({
            video: 'unknown',
            audio: 'unknown',
            container: 'unknown',
            compatible: false,
            needsRemux: false,
            needsTranscode: true,
            probeError: true,
            error: err.message
        });
    }
});

module.exports = router;
