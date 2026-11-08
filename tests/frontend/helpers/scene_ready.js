// When a census scene is ready to be measured (#416): its own content is drawn, not a fixed time after it was opened. A scene that fills from
// data (the Inbox, Docs, a side-panel tab, a composer menu, the approval card) used to be measured after a fixed 400 + 600 ms, and on a busy
// machine some were measured half-drawn (QA's #6574: the Inbox at 30 of 144 texts); a scene with nothing to wait for waited the full time anyway.
//
// A scene is ready when, for two samples in a row, nothing the page asked for is still on its way and nothing is moving:
//   - no fetch in flight, and the last one ended at least QUIET_AFTER_FETCH ms ago (its data had a paint to land in);
//   - the page's content has not changed for QUIET_AFTER_CHANGE ms (a list drawn again by a timer, or by a module that came by import(),
//     which no fetch counts);
//   - no element on screen marked aria-busy (a list that is loading says so);
//   - no animation running that will end (an endless one, a spinner or a pulse, never ends and is not waited for).
// It is given READY_CAP ms. A scene still not ready by then fails the census: a scene measured early must never pass silently (the
// Orchestrator on #416). The one exception is knownSlow, which names its reason and the one aria-busy element the scene keeps busy; the
// scene must still be ready otherwise.

/** Installed with the harness's PRELOAD (Page.addScriptToEvaluateOnNewDocument), after it: counts the page's fetches, the harness's mocked
 *  ones included (they are the page's requests too), and notes when the page's content last changed (elements added or removed, text, and
 *  the attributes that show or hide something). */
const FETCH_COUNTER = `(() => {
    if (window.__qaFetch) return;
    const s = window.__qaFetch = { inflight: 0, lastDone: 0, urls: new Map(), n: 0, lastChange: 0 };
    new MutationObserver(() => { s.lastChange = performance.now(); }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'open', 'disabled', 'inert', 'aria-hidden', 'aria-expanded'] });
    const real = window.fetch;
    window.fetch = function (...args) {
        const id = ++s.n, end = () => { s.inflight--; s.urls.delete(id); s.lastDone = performance.now(); };
        s.inflight++; s.urls.set(id, String(args[0] && args[0].url || args[0]).replace(location.origin, ''));
        let p;
        try { p = real.apply(this, args); } catch (e) { end(); throw e; }
        return Promise.resolve(p).finally(end);
    };
})()`;

const QUIET_AFTER_FETCH = 150; // ms after the last fetch ended
const QUIET_AFTER_CHANGE = 200; // ms after the page's content last changed
const READY_CAP = 3000; // ms a scene is given to be ready
const SAMPLE_EVERY = 60; // ms between two samples

/** The page expression that says what is still going on ('' when nothing is). ignore (from a scene's knownSlow) leaves out what the scene
 *  is known to keep going: busy, a selector of the aria-busy elements that stay busy. Anything else still fails the scene at the cap. */
const quiet = (ignore = {}) => `(() => {
    const s = window.__qaFetch, now = performance.now();
    if (s && s.inflight > 0) return 'a fetch (' + [...s.urls.values()].join(', ').slice(0, 160) + ')';
    if (s && now - s.lastDone < ${QUIET_AFTER_FETCH}) return 'a fetch';
    if (s && now - s.lastChange < ${QUIET_AFTER_CHANGE}) return 'a change on the page';
    if ([...document.querySelectorAll('[aria-busy="true"]')].some(e => e.getClientRects().length && !${ignore.busy ? `e.closest(${JSON.stringify(ignore.busy)})` : 'false'})) return 'aria-busy';
    const moving = document.getAnimations().some(a => a.playState === 'running' && !(a.effect && a.effect.getTiming && a.effect.getTiming().iterations === Infinity));
    return moving ? 'an animation' : '';
})()`;

/** Waits until expr (a page expression) is true, sampling every SAMPLE_EVERY ms, for at most cap ms; returns whether it became true. */
async function until(ev, expr, cap) {
    const end = Date.now() + cap;
    for (;;) {
        if (await ev(`!!(${expr})`)) return true;
        if (Date.now() >= end) return false;
        await new Promise(r => setTimeout(r, SAMPLE_EVERY)); // sleep-ok: the sampling interval of a bounded wait
    }
}

/** sceneReady waits for a scene opened by its setup: its expect (when given) and then quiet for two samples in a row. It throws, naming what
 *  was still going on, when the scene is not ready within READY_CAP. knownSlow is { why, busy }: its reason and a selector of the aria-busy
 *  element the scene keeps busy. Only that aria-busy is left out: the scene is measured as soon as everything else is quiet and still fails
 *  at the cap if anything else is not. There is no way to measure a scene at the cap as it is. */
async function sceneReady(ev, name, { expect, knownSlow } = {}) {
    const start = Date.now(), ignore = knownSlow || {};
    if (knownSlow !== undefined && !(typeof knownSlow === 'object' && typeof knownSlow.why === 'string' && knownSlow.why && typeof knownSlow.busy === 'string' && knownSlow.busy)) throw new Error('knownSlow is { why, busy }: its reason and the aria-busy selector it leaves out');
    if (!(await ev('!!window.__qaFetch'))) throw new Error('FETCH_COUNTER is not installed on this page, so its fetches and changes are not seen'); // a census adds it with its PRELOAD
    if (expect && !(await until(ev, expect, READY_CAP))) throw new Error(`the scene is not showing (${expect.slice(0, 80)})`);
    const expr = quiet(ignore);
    let calm = 0, why = '';
    while (Date.now() - start < READY_CAP) {
        why = await ev(expr);
        calm = why ? 0 : calm + 1;
        if (calm >= 2) return Date.now() - start;
        await new Promise(r => setTimeout(r, SAMPLE_EVERY)); // sleep-ok: the sampling interval of a bounded wait
    }
    throw new Error(`not ready after ${READY_CAP} ms (${why} still going on): measured now, it would be measured early; mark it knownSlow with its reason if that is expected`);
}

/** The censuses' known-slow scenes, by what they keep going (each one names its reason). */
const KNOWN_SLOW = {
    // goals_stub's goal 1 has a rollup of 9 tasks and 3 task rows: the view says Updating and keeps its tasks list aria-busy while the two
    // disagree (#7513), which in the stub is for good. The scene is drawn; only that list's aria-busy is left out.
    goalUpdating: { why: "the stub goal's rollup and rows disagree, so its list stays aria-busy", busy: '#team-panel-goals' },
};

module.exports = { FETCH_COUNTER, sceneReady, READY_CAP, KNOWN_SLOW };
