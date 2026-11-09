/* Whether Dropbox is connected, for Share via Dropbox's entries (#14944): the file viewer's More actions item and the two board chats' selection
 * bars. Each caller asks only for this computer's own file or board, outside Coral Hub (through a Hub the status route is refused, so nothing is
 * offered there). Read at most once a minute; false on any refusal or failure. */
let at = 0, on = null;

export function dropboxConnected() {
    if (on && Date.now() - at < 60_000) return on;
    at = Date.now();
    on = fetch('/api/dropbox/status', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).then(j => !!(j && j.connected)).catch(() => false);
    return on;
}
