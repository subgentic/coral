/* Startup's banner, password prompt and Hub offer read the same browser identity.
 * Share one read and a five-second answer; errors are never retained. A password
 * change or return to this tab invalidates it before consumers check again. */
let pending = null, saved = null, until = 0, generation = 0;
const forget = () => { generation++; pending = null; saved = null; until = 0; };
document.addEventListener('coral:password-changed', forget);
document.addEventListener('visibilitychange', () => { if (!document.hidden) forget(); });
export function readAuthStatus({ fresh = false } = {}) {
    if (fresh || window.__coralNoFetchShare === true) forget();
    if (pending) return pending;
    if (saved && Date.now() < until) return Promise.resolve(saved);
    const gen = generation;
    const read = fetch('/api/system/auth-status', { credentials: 'same-origin', cache: 'no-store' })
        .then(r => r.ok ? r.json() : null).then(data => {
            const answer = data && typeof data === 'object' ? data : null;
            if (answer && gen === generation) { saved = answer; until = Date.now() + 5000; }
            return answer;
        }).catch(() => null).finally(() => { if (pending === read) pending = null; });
    pending = read;
    return read;
}
