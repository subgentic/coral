// The Board tab keeps what the board's chat showed inline (#7535, the census's board chat rows): a message from another computer lists its files as chips under the text (an image with its thumbnail, another file with its size) and a plain click on a chip opens the
// artifact viewer; an artifact image in the text is an image of this server; an @mention is marked; and the composer is named "Message the team" with its button "Send" only while the column is in the team page (the board page keeps its own names).
// The board's messages are stubbed in the page. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-msgfiles-${Date.now() % 100000}`;
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await seed(ev, TEAM);
        await ev(`(() => { const D = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src'); // thumbnails are not loaded (the artifact is not real): the address the chip gives is kept, so the chip stays an image chip
            Object.defineProperty(HTMLImageElement.prototype, 'src', { configurable: true, get() { return this.__src || D.get.call(this); }, set(v) { if (this.hasAttribute('data-attachment-img')) this.__src = v; else D.set.call(this, v); } });
            const R = window.fetch.bind(window); const j = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            const msg = { id: 900, project: ${JSON.stringify(TEAM)}, subscriber_id: 'Build Bot', job_title: 'Bot', created_at: '2026-10-25T07:00:00Z', content: '@Orchestrator the build is done, see ![shot](coral://artifacts/${C})',
                external: { direction: 'inbound', server_id: 'm2', attachments: [{ id: '${A}', name: 'shot.png', media_type: 'image/png', size: 2048 }, { id: '${B}', name: 'build-log.txt', media_type: 'text/plain', size: 900 }, { id: '${C}', name: 'inline.png', media_type: 'image/png', size: 70 }] } };
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                if (/\\/api\\/board\\/[^/]+\\/messages\\/all$/.test(url.pathname) && !url.searchParams.get('after_id')) return j({ messages: [msg], total: 1, before_count: 0 });
                if (/\\/api\\/board\\/[^/]+\\/subscribers$/.test(url.pathname)) return j([{ subscriber_id: 'Orchestrator', job_title: 'Orchestrator' }]);
                if (/^\\/api\\/artifacts\\/[a-f0-9]{64}$/.test(url.pathname)) { const png = !url.pathname.endsWith('${B}'); return Promise.resolve(new Response(png ? Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0)) : 'log text', { headers: { 'Content-Type': png ? 'image/png' : 'text/plain' } })); }
                return R(u, o); }; return true; })()`);
        await openTeam(ev, waitFor, TEAM); await goTab(ev, settle, 'Board'); await settle(900);
        await S.run('files from another computer are chips under the message: an image with a thumbnail, a file with its size', async () => {
            const chips = await ev(`[...document.querySelectorAll('#team-panel-messages .mb-attachment')].map(c => ({ name: c.getAttribute('aria-label'), image: c.classList.contains('is-image'), thumb: !!c.querySelector('img.mb-attachment-thumb'), size: (c.querySelector('.mb-attachment-size') || {}).textContent || '' }))`);
            assert.deepEqual(chips.map(c => c.name), ['Open shot.png, 2.0 KB', 'Open build-log.txt, 900 B', 'Open inline.png, 70 B'], JSON.stringify(chips));
            assert.equal(chips[0].image, true, JSON.stringify(chips)); assert.equal(chips[0].thumb, true, 'the image has its thumbnail ' + JSON.stringify(chips)); assert.equal(chips[1].size, '900 B', JSON.stringify(chips));
            assert.match(await ev(`document.querySelector('#team-panel-messages .mb-attachment img').src || ''`), new RegExp('/api/artifacts/' + A));
        });
        await S.run('a plain click on a chip opens the artifact viewer', async () => {
            await ev(`document.querySelector('#team-panel-messages .mb-attachment:not(.is-image)').click(); true`);
            await waitFor(`(() => { const v = document.getElementById('artifact-viewer'); return !!v && !v.hidden; })()`, 'the viewer', 6000);
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
        });
        await S.run('an artifact image in the text is an image of this server, and an @mention is marked', async () => {
            assert.match(await ev(`(document.querySelector('#team-panel-messages .mb-message-body img[data-artifact]') || {}).src || ''`), new RegExp('/api/artifacts/' + C));
            assert.ok(await ev(`!!document.querySelector('#team-panel-messages .mb-message-body .mb-mention')`), 'the @mention has its own mark');
        });
        await S.run('the composer is named for the team page, and the board page gets its own names back', async () => {
            const names = () => ev(`[document.getElementById('mb-post-input').getAttribute('aria-label'), document.querySelector('#mb-board .mb-post-send-btn').getAttribute('aria-label')]`);
            assert.deepEqual(await names(), ['Message the team', 'Send']);
            await goTab(ev, settle, 'Goals'); await settle(400);
            assert.deepEqual(await names(), ['Post message to board', 'Send message'], 'back on the board page the names are the board page\'s');
        });
        await removeBoards(ev, [TEAM]); S.finish();
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
