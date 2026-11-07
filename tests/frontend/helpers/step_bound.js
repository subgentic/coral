// A limit for one step of a CDP suite (#14270, #14286). A bare `await ev(...)` has no limit of its own: a page request that never answers holds the suite until the runner kills it at 120 s, and the failure names
// nothing (review_changes_picture_browser hung once in three runs that way, and 70 later runs passed, so the stalled step was never seen). bound() gives a step a limit: it rejects at the limit with the step's
// name, and, when a diagnosis is passed, with what that says (the page's requests that have not answered). Use it on a step that waits on the network or on something outside the suite.
//
//   const { bound } = require('./helpers/step_bound');
//   await bound(ev(`fetch(...)`), 20000, 'the subscribe call', () => ev(`[...window.__pend.values()].join(', ')`));
//
// An answer in time is returned as is, a step that fails by itself keeps its own error, the diagnosis is asked once, is itself limited to 2 s, and its own failure costs nothing; the timers are cleared as soon as the step answers (they are not unref'd: a wait that is only a timer must still fire).

const DIAG_MS = 2000;

function bound(promise, ms, what, diag) {
    let timer;
    const limit = new Promise((_, reject) => {
        timer = setTimeout(async () => {
            let extra = '';
            if (typeof diag === 'function') {
                let t2;
                try {
                    const asked = new Promise(resolve => { t2 = setTimeout(() => resolve(null), DIAG_MS); });
                    const said = await Promise.race([Promise.resolve().then(diag), asked]);
                    if (said) extra = ` | the page was still waiting for: ${said}`;
                } catch { /* the diagnosis is a help, never a second failure */ } finally { clearTimeout(t2); }
            }
            reject(new Error(`${what}: no answer within ${ms} ms${extra}`));
        }, ms);
    });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

module.exports = { bound };
