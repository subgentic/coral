// The board composer's @ mention picker (#7549, the dock chat's picker as a combobox; the census's board_chat.js picker and @all rows): typing "@" at the start or after a space opens a list named "Mention an agent" with "@all" first,
// filtered as the name is typed; arrow keys move, Enter or Tab picks, Escape closes; with the list closed Enter sends. The box is a combobox (aria-expanded, aria-controls, aria-activedescendant); a row is 44 px on a phone.
// The team's members are stubbed in the page. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const VIEWS = [['1280x800', 1280, 800, false], ['390x844', 390, 844, true]];
const TEAM = `qa-mention-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const box = `window.__tp.find('textarea', /^Message the team$/i)`;
    const type = (text) => ev(`(() => { const b = ${box}; b.focus(); b.value = ${JSON.stringify(text)}; b.selectionStart = b.selectionEnd = b.value.length; b.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const key = (k) => ev(`(() => { const b = ${box}; b.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true })); return true; })()`);
    const list = () => ev(`(() => { const b = ${box}; const l = document.getElementById(b.getAttribute('aria-controls') || ''); if (!l || l.hidden) return null; const opts = [...l.querySelectorAll('[role=option]')]; return { name: window.__na.name(l), expanded: b.getAttribute('aria-expanded'), active: b.getAttribute('aria-activedescendant'), options: opts.map(o => ({ id: o.id, text: o.textContent, selected: o.getAttribute('aria-selected'), h: Math.round(o.getBoundingClientRect().height) })) }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of VIEWS) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
            await seed(ev, TEAM);
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await ev(`(() => { const R = window.fetch.bind(window); window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                if (/\\/api\\/board\\/[^/]+\\/subscribers$/.test(url.pathname)) return Promise.resolve(new Response(JSON.stringify([{ subscriber_id: 'Orchestrator', job_title: 'Orchestrator' }, { subscriber_id: 'Backend Dev', job_title: 'Backend Dev' }, { subscriber_id: 'Operator', job_title: 'Operator' }]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                return R(u, o); }; return true; })()`);
            await openTeam(ev, waitFor, TEAM).catch(() => {}); await goTab(ev, settle, 'Board'); await settle(1200);
            await S.run(`${label}: "@" opens a list named "Mention an agent": @all first with its note, then the agents; the box is a combobox with the first row active`, async () => {
                await type('@'); await settle(200);
                const l = await list(); assert.ok(l, 'the list opens');
                assert.equal(l.name, 'Mention an agent'); assert.equal(l.expanded, 'true'); assert.equal(l.active, l.options[0].id, 'the first row is the active descendant');
                assert.match(l.options[0].text, /^@all/); assert.match(l.options[0].text, /Notify all agents/);
                assert.deepEqual(l.options.slice(1).map(o => o.text), ['Orchestrator', 'Backend Dev'], 'the agents in the board\'s order, the operator not among them');
                if (mobile) for (const o of l.options) assert.ok(o.h >= 44, `${o.text} is ${o.h} px high`);
                assert.equal(await ev(`${box}.getAttribute('role')`), 'combobox');
            });
            await S.run(`${label}: typing filters the list; an @ inside a word opens nothing`, async () => {
                await type('Hello @or'); await settle(200);
                assert.deepEqual((await list()).options.map(o => o.text), ['Orchestrator'], 'only the names holding "or"');
                await type('write to me@or'); await settle(200);
                assert.equal(await list(), null, 'an @ after a letter (an address) opens no list');
                await type('@zzz'); await settle(200);
                assert.equal(await list(), null, 'no name, no list');
            });
            await S.run(`${label}: the arrow keys move, Enter picks and does not send, the name goes in with a space`, async () => {
                await ev(`window.__tp.record()`);
                await type('Hi @'); await settle(200);
                await key('ArrowDown'); await settle(100);
                let l = await list(); assert.equal(l.options[1].selected, 'true'); assert.equal(l.active, l.options[1].id, 'ArrowDown moves the active row');
                await key('ArrowUp'); await key('ArrowUp'); await settle(100);
                l = await list(); assert.equal(l.options[l.options.length - 1].selected, 'true', 'ArrowUp from the first wraps to the last');
                await key('Enter'); await settle(200);
                assert.equal(await ev(`${box}.value`), 'Hi @Backend Dev ', 'the last row was picked, with a space after it');
                assert.equal(await list(), null, 'the list closed');
                assert.equal((await ev(`window.__writes`)).some(x => /\/messages$/.test(x.p)), false, 'Enter picked, it did not send');
            });
            await S.run(`${label}: Tab picks, and @all goes in as @all`, async () => {
                await type('@a'); await settle(200);
                assert.match((await list()).options[0].text, /^@all/);
                await key('Tab'); await settle(200);
                assert.equal(await ev(`${box}.value`), '@all ', 'Tab picked @all');
            });
            await S.run(`${label}: Escape closes the list and keeps the text; with the list closed Enter sends`, async () => {
                await type('Look @B'); await settle(200);
                assert.ok(await list(), 'open'); await key('Escape'); await settle(150);
                assert.equal(await list(), null, 'Escape closed it'); assert.equal(await ev(`${box}.value`), 'Look @B', 'the text is as typed');
                await ev(`window.__writes.length = 0; true`);
                await type('Look @Orchestrator '); await settle(200);
                assert.equal(await list(), null, 'no list after a picked name');
                await key('Enter'); await settle(800);
                const sent = await ev(`window.__writes`);
                assert.ok(sent.some(x => x.m === 'POST' && /\/messages$/.test(x.p) && /Look @Orchestrator/.test(x.b)), `Enter sent the message (${JSON.stringify(sent.map(x => x.m + ' ' + x.p))})`);
            });
            await S.run(`${label}: moving the caret re-reads the @ it is at (QA Reviewer 2's #7549 follow-up A): Enter then picks at the caret`, async () => {
                await type('@Ba'); await settle(200);
                assert.deepEqual((await list()).options.map(o => o.text), ['Backend Dev'], 'the query is "Ba"');
                await ev(`(() => { const b = ${box}; b.selectionStart = b.selectionEnd = 2; b.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true })); return true; })()`); await settle(200);
                assert.deepEqual((await list()).options.map(o => o.text.replace(/\s+Notify.*/, '')), ['Backend Dev'], 'the caret is after "B": the query is "B"');
                await key('Enter'); await settle(200);
                assert.equal(await ev(`${box}.value`), '@Backend Dev a', 'the pick replaced "@B" at the caret and kept the "a" after it');
                await type('x @Orch'); await settle(200);
                assert.ok(await list(), 'open at the end');
                await ev(`(() => { const b = ${box}; b.selectionStart = b.selectionEnd = 1; b.dispatchEvent(new KeyboardEvent('keyup', { key: 'Home', bubbles: true })); return true; })()`); await settle(200);
                assert.equal(await list(), null, 'the caret moved away from the @: the list closes');
            });
            await S.run(`${label}: a name picked in the middle of a text keeps one space (follow-up B)`, async () => {
                await ev(`(() => { const b = ${box}; b.focus(); b.value = 'see @ and more'; b.selectionStart = b.selectionEnd = 5; b.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await settle(200);
                assert.ok(await list(), 'the list opens at the @ in the middle');
                await key('ArrowDown'); await key('Enter'); await settle(200);
                assert.equal(await ev(`${box}.value`), 'see @Orchestrator and more', 'one space between the name and "and"');
                assert.equal(await ev(`${box}.selectionStart`), 'see @Orchestrator '.length, 'the caret is after the space, in front of "and"');
            });
            await S.run(`${label}: Escape keeps the list closed when the caret moves (it opens again when something is typed), and a caret move keeps the highlighted row`, async () => {
                await type('@Or'); await settle(200);
                await key('Escape'); await settle(150);
                assert.equal(await list(), null, 'Escape closed it');
                await ev(`(() => { const b = ${box}; b.selectionStart = b.selectionEnd = 2; b.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true })); return true; })()`); await settle(150);
                assert.equal(await list(), null, 'an arrow after Escape does not open it again');
                await type('@Or'); await key('Escape'); await type('@Orc'); await settle(200);
                assert.ok(await list(), 'typing opens it again');
                await type('@'); await settle(200);
                await key('ArrowDown'); await settle(100);
                const before = (await list()).options.findIndex(o => o.selected === 'true');
                await ev(`(() => { const b = ${box}; b.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true })); return true; })()`); await settle(150);
                assert.equal((await list()).options.findIndex(o => o.selected === 'true'), before, 'the highlighted row stays where the arrow put it');
            });
        }
        await removeBoards(ev, [TEAM]); S.finish(); // finish() exits the process, so the board goes first
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
