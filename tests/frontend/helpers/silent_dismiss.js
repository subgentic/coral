// The operator's rule (#11552): dismissing an item in Needs you sends nothing to the agent. A browser suite installs this guard before it clicks a Dismiss, an Ignore or a swipe, and asks it afterwards: every
// request the page made that could reach an agent (a board message, a comment, a send, a reply) is recorded, whatever answered it. Decisions (Approve, Deny, Request changes, a question's reply) are not dismissals and
// are not run through it.
const REACHES_AN_AGENT = String.raw`/\/(messages|send|comments|reply)(\/|$|\?)|\/api\/sessions\/live\/[^/]+\/(send|keys|input)/`;

/** Wrap the page's fetch to record every non-GET request that could reach an agent into window.__reached. Call once per page load, after the suite's own fetch stub. */
const installGuard = ev => ev(`(() => { window.__reached = []; const inner = window.fetch; const reach = ${REACHES_AN_AGENT};
    window.fetch = (url, opts = {}) => { const method = String((opts && opts.method) || 'GET').toUpperCase(), path = new URL(String(url), location.origin).pathname; if (method !== 'GET' && reach.test(path)) window.__reached.push(method + ' ' + path); return inner(url, opts); }; return true; })()`);

/** What reached an agent since the guard was installed. A dismissal must leave this empty. */
const reached = ev => ev(`window.__reached || []`);

module.exports = { installGuard, reached };
