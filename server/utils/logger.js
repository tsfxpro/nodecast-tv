'use strict';
const LEVELS = { debug: 0, info: 1, error: 2 };
const level = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 1;

const pfx = (label, a) =>
    typeof a[0] === 'string' ? [`${label} ${a[0]}`, ...a.slice(1)] : [label, ...a];

module.exports = {
    debug: (...a) => { if (level <= 0) console.log(...pfx('[DEBUG]', a)); },
    info:  (...a) => { if (level <= 1) console.log(...pfx('[INFO] ', a)); },
    warn:  (...a) => { if (level <= 1) console.warn(...pfx('[WARN] ', a)); },
    error: (...a) => { console.error(...pfx('[ERROR]', a)); },
    timer: () => { const t = Date.now(); return () => Date.now() - t; },
};
