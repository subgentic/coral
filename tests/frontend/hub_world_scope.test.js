// A Hub census's real loopback feed must be opt-in: granting permission to
// unrelated Hub fixtures lets the isolated Go feed erase their stub inventory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const helper = require.resolve('./helpers/hub_world');
const loaded = { exports: {} };
new Function('require', 'module', 'exports', fs.readFileSync(process.env.HUB_WORLD_SOURCE || helper, 'utf8'))(createRequire(helper), loaded, loaded.exports);
const { setupHubWorld, BASE } = loaded.exports;

async function world(hubFeed) {
    let source; const grants = [];
    class Socket extends EventTarget { constructor(url) { super(); this.url = url; } }
    await setupHubWorld({
        client: {
            Browser: { PermissionType: { enum: ['localNetworkAccess', 'loopbackNetwork'] }, grantPermissions: async p => grants.push(p) },
            Fetch: { enable: async () => {}, requestPaused() {} }, // paused-ok: inert fake CDP registrar; setupHubWorld registers its handler through safePaused
            Network: { enable: async () => {}, setBypassServiceWorker: async () => {} }
        },
        Page: { enable: async () => {}, addScriptToEvaluateOnNewDocument: async p => { source = p.source; } },
        Emulation: { setDeviceMetricsOverride: async () => {}, setTouchEmulationEnabled: async () => {} },
        width: 1280, height: 800, mobile: false, ...(hubFeed === undefined ? {} : { hubFeed })
    });
    const context = { URL, Response, WebSocket: Socket, location: { href: BASE + '/' }, document: { addEventListener() {} }, localStorage: { setItem() {} }, fetch: async () => { throw new Error('unexpected real fetch'); } };
    context.window = context; vm.runInNewContext(source, context);
    const inventory = () => context.fetch(BASE + '/api/sessions/live').then(r => r.json());
    return { context, grants, Socket, inventory };
}
(async () => {
    for (const option of [undefined, false]) {
        const w = await world(option);
        assert.equal(w.grants.length, 0, 'default Hub fixtures must not grant live-feed network permission');
        assert.equal(w.context.WebSocket, w.Socket, 'default fixtures retain the browser socket unchanged');
        const data = await w.inventory();
        assert.deepEqual(data.servers.map(s => s.label), ['Laptop', 'Desktop']);
        assert.equal(data.sessions.length, 3);
        w.context.__noComputers = true;
        assert.deepEqual(await w.inventory(), { sessions: [], servers: [] });
    }
    const w = await world(true);
    assert.deepEqual(w.grants, [{ origin: new URL(BASE).origin, permissions: ['localNetworkAccess', 'loopbackNetwork'] }]);
    const socket = new w.context.WebSocket(BASE.replace(/^http/, 'ws') + '/ws/coral');
    assert.ok(socket instanceof w.Socket, 'opt-in keeps the real socket lifecycle');
    let received; socket.addEventListener('message', e => { received = JSON.parse(e.data); });
    const send = () => {
        const event = new Event('message');
        Object.defineProperty(event, 'data', { value: JSON.stringify({ type: 'coral_update', sessions: [], notifications: [{ text: 'retain notice' }] }), configurable: true });
        socket.dispatchEvent(event);
    };
    send();
    assert.deepEqual(received.sessions, (await w.inventory()).sessions);
    assert.deepEqual(received.servers, (await w.inventory()).servers);
    assert.equal(received.notifications[0].text, 'retain notice');
    w.context.__computers[0].online = false; send();
    assert.equal(received.servers[0].online, false, 'feed reflects fixture status transitions');
    console.log('PASS hub_world_scope: default fixtures grant no permission; opt-in feed and HTTP share inventory');
})().catch(e => { console.error(e); process.exitCode = 1; });
