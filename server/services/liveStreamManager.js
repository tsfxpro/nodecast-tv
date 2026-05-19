// Tracks one active ffmpeg process per remote client IP for live streams.
// When a new live stream is requested from the same client, the previous ffmpeg
// must be fully dead (and the VPN-side TCP connection closed) before the new one
// opens — otherwise IPTV providers that enforce a single-stream policy return 458.
const sessions = new Map(); // clientIp → { process, sessionId }

/**
 * Kill the previous live stream process for this client (if any) and wait for
 * it to exit, then hold an extra grace period for the VPN TCP close to propagate.
 */
async function killAndWait(clientIp, gracePeriodMs = 800) {
    const session = sessions.get(clientIp);
    if (!session) return;

    sessions.delete(clientIp);
    const proc = session.process;

    await new Promise(resolve => {
        const timeout = setTimeout(resolve, 2000); // safety cap
        proc.once('exit', () => {
            clearTimeout(timeout);
            resolve();
        });
        try { proc.kill('SIGKILL'); } catch (_) {}
    });

    // Give gluetun/provider time to register the TCP RST before we open a new connection.
    await new Promise(r => setTimeout(r, gracePeriodMs));
}

function register(clientIp, process, sessionId) {
    sessions.set(clientIp, { process, sessionId });
}

// Only removes the entry if it still belongs to the given session (guards against
// a stale req.on('close') unregistering a newer session that already took over).
function unregisterIfCurrent(clientIp, sessionId) {
    const session = sessions.get(clientIp);
    if (session && session.sessionId === sessionId) {
        sessions.delete(clientIp);
    }
}

module.exports = { killAndWait, register, unregisterIfCurrent };
