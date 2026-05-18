'use strict';

// Loaded via NODE_OPTIONS=--require before any app code.
// Ensures every outbound fetch() call:
//   1. Routes through gluetun VPN (undici ProxyAgent from HTTP_PROXY)
//   2. Carries a consistent browser User-Agent
//   3. Never sends X-Forwarded-For / Via / Forwarded to the IPTV provider

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SCRUB_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'via',
  'forwarded',
  'proxy-connection',
];

// Wire native fetch() through gluetun so IPTV provider sees the VPN IP.
// Native Node.js fetch (undici) does not read HTTP_PROXY automatically.
try {
  const { ProxyAgent, setGlobalDispatcher } = require('undici');
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy;
  if (proxyUrl) {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  }
} catch (_) {
  // undici not directly require()-able in this build; proxy routing unchanged.
}

// Patch globalThis.fetch to enforce clean outbound headers on every call.
const _origFetch = globalThis.fetch;
if (typeof _origFetch === 'function') {
  globalThis.fetch = function fetchPatched(input, init) {
    const opts = Object.assign({}, init);
    const headers = new Headers(opts.headers);

    if (!headers.has('user-agent')) {
      headers.set('User-Agent', BROWSER_UA);
    }

    for (const name of SCRUB_HEADERS) {
      headers.delete(name);
    }

    opts.headers = headers;
    return _origFetch.call(this, input, opts);
  };
}
