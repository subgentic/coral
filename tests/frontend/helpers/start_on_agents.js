// A bare "/" starts on the Inbox since #11594, and nearly every browser suite means the Agents page when it loads "/". run_cdp_suites.mjs gives each suite process this file with NODE_OPTIONS --require, so every
// chrome-remote-interface client (the shared harness and the ~90 suites that open their own) puts "/agents" in the address of a page that opened on a bare "/", before any app script runs: the address a person
// types for the list, which nav.js does not move. A suite that is about the start page itself sets process.env.CORAL_KEEP_START = '1' before it connects. A callback-style call is left alone.
const Module = require('node:module');
const SOURCE = `(() => { try { if (location.pathname === '/' && !location.search && !location.hash) history.replaceState(null, '', '/agents'); } catch (e) {} })()`;
const load = Module._load;
Module._load = function (request, ...rest) {
    const real = load.call(this, request, ...rest);
    if (request !== 'chrome-remote-interface' || typeof real !== 'function' || real.__startOnAgents) return real;
    const wrapped = async function (...args) {
        const client = await real.apply(this, args);
        if (!process.env.CORAL_KEEP_START && client && client.Page && typeof args[args.length - 1] !== 'function') {
            try { await client.Page.enable(); await client.Page.addScriptToEvaluateOnNewDocument({ source: SOURCE }); } catch { /* the suite's own setup reports a dead client */ }
        }
        return client;
    };
    Object.assign(wrapped, real); wrapped.__startOnAgents = true;
    return wrapped;
};
