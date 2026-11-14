// A team's uncommitted work (#17203, slice 1): the team page says "Files changed in <folder>, not committed: N changed, M new" with Review changes and Commit; Commit asks for a message (the goal's title),
// says "unsigned local commit; git hooks are not run", leaves secret-looking files out unless ticked, shows git's output when it fails, and makes one commit (POST commit). The routes are stubbed. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-uncommitted-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await ev(`window.__commits = []; window.__fail = false; window.__dirty = true; const real = window.fetch;
            window.fetch = (u, o = {}) => { const url = String(u && u.url ? u.url : u), m = (o.method || 'GET').toUpperCase(), json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                if (m === 'GET' && /\\/uncommitted$/.test(url)) return json({ repos: window.__dirty ? [{ folder: '/work/shop', changed: 2, new: 1, files: [{ path: 'a.go', status: 'changed' }, { path: 'b.go', status: 'changed' }, { path: '.env', status: 'new' }], secret_like: ['.env'], signing: false, truncated: false }] : [] });
                if (m === 'POST' && /\\/commit$/.test(url)) { window.__commits.push(JSON.parse(o.body)); if (window.__fail) return json({ error: 'git could not commit', code: 'commit_failed', output: 'fatal: boom' }, 409); window.__dirty = false; return json({ ok: true, folder: '/work/shop', commit: 'abc1234', files: 2 }); }
                if (m === 'GET' && /\\/goals\\?/.test(url)) return json({ goals: [{ id: 1, title: 'Ship the shop', state: 'active' }] });
                return real(u, o); }; true`);
        await seed(ev, TEAM); await openTeam(ev, waitFor, TEAM); await settle(500);
        const q = (s) => `document.querySelector('#team-page-uncommitted ${s}')`;
        await waitFor(`!!${q('.team-uncommitted-words')}`, 'the uncommitted line', 8000);
        assert.equal(await ev(`${q('.team-uncommitted-words')}.textContent`), 'Files changed in shop, not committed: 2 changed, 1 new');
        assert.equal(await ev(`${q('.team-uncommitted-files')}.hidden`), true, 'the list is closed until asked');
        await ev(`${q('.team-uncommitted-review')}.click(); true`);
        assert.match(await ev(`${q('.team-uncommitted-files')}.textContent`), /a\.go[\s\S]*b\.go/, 'Review changes lists the files');
        await ev(`${q('.team-uncommitted-commit')}.click(); true`);
        await waitFor(`!!${q('.team-uncommitted-message')}`, 'the commit form', 5000);
        assert.equal(await ev(`${q('.team-uncommitted-message')}.value`), 'Ship the shop', 'the message is the goal title');
        const text = await ev(`${q('.team-uncommitted-form')}.textContent`);
        assert.match(text, /nsigned local commit; git hooks are not run/);
        assert.match(text, /\.env/, 'the secret-looking file is named');
        await ev(`window.__fail = true; ${q('.team-uncommitted-go')}.click(); true`);
        await waitFor(`!${q('.team-uncommitted-output')}.hidden`, "git's output on a failure", 5000);
        assert.match(await ev(`${q('.team-uncommitted-output')}.textContent`), /fatal: boom/);
        assert.deepEqual(await ev(`window.__commits[0]`), { folder: '/work/shop', message: 'Ship the shop', include_secret_like: false }, 'secret-like files are not included by default');
        await ev(`window.__fail = false; ${q('.team-uncommitted-secret input')}.click(); ${q('.team-uncommitted-go')}.click(); true`);
        await waitFor(`window.__commits.length === 2 && ${'document.getElementById("team-page-uncommitted")'}.hidden`, 'one commit, then the line goes', 5000);
        assert.equal((await ev(`window.__commits[1]`)).include_secret_like, true, 'ticked: included');
        console.log('PASS team page: uncommitted line, Review changes, Commit with message, secret-like tick, unsigned note, git output on failure');
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
