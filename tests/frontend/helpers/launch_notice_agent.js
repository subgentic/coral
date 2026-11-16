// Geometry measures one continuously present local agent. The isolated server's
// empty real feed must describe that same fixture before install() detaches it.
const register = `window.__m.add('Notice fixture', '', 0, { session_id: 'notice-fixture', sleeping: false });`;
exports.REAL_FEED_PRELOAD = register; // the recovery regression deliberately lets the empty feed through
exports.PRELOAD = register + `(() => {
    const Real = window.WebSocket;
    function W(url, protocols) {
        const socket = protocols === undefined ? new Real(url) : new Real(url, protocols);
        if (String(url).includes('/ws/coral')) {
            const existing = Object.getOwnPropertyDescriptor(socket, 'onmessage');
            let handler = null;
            const deliver = event => {
                let data;
                try { data = JSON.parse(event.data); } catch { handler?.call(socket, event); return; }
                if (data.type === 'coral_update' && Array.isArray(data.sessions)) {
                    data.sessions = Object.values(window.__m.agents).map(agent => window.__m.entry(agent));
                    event = new MessageEvent('message', { data: JSON.stringify(data) });
                }
                handler?.call(socket, event);
            };
            Object.defineProperty(socket, 'onmessage', {
                configurable: true,
                get() { return handler; },
                set(value) { handler = value; if (existing?.set) existing.set.call(socket, value ? deliver : null); }
            });
            if (!existing?.set) socket.addEventListener('message', deliver);
        }
        return socket;
    }
    W.prototype = Real.prototype;
    for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) W[key] = Real[key];
    window.WebSocket = W;
})();`;
