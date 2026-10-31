/* Register the service worker, except on the Cloud Hub: its pages and API
 * answers are per-user, and a worker that caches them could leak one account's
 * data to the next person on the same browser. On the Hub every worker of the origin
 * is removed except one whose scope is exactly '<origin>/push/' and whose worker (active,
 * waiting or installing) is exactly '<origin>/push/sw.js' (the Hub's push-only worker, #11603). */
(function () {
    var mode = 'local';
    try { mode = JSON.parse(document.getElementById('coral-boot').textContent).mode || 'local'; } catch (_) {}
    if (mode === 'cloud') {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistrations().then(function (rs) { rs.forEach(function (r) { var o = location.origin, w = [r.active, r.waiting, r.installing].filter(Boolean); if (!(r.scope === o + '/push/' && w.length && w.every(function (x) { return x.scriptURL === o + '/push/sw.js'; }))) r.unregister(); }); }).catch(function () {}); // the Hub's push-only worker (scope exactly /push/ and script exactly /push/sw.js: it caches nothing) is the one exception (#11603)
        }
        return;
    }
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/static/sw.js', { scope: '/', updateViaCache: 'none' }).catch(function () {});
    }
})();
