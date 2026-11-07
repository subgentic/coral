// A Needs you row answers Claude's folder-trust prompt (#14110, the beta run's inbox-only user; Security's conditions): "No, exit" and "Yes, I trust this folder" as buttons, the folder as plain text with one line
// saying what Yes does, and a second press before Yes is sent (a lasting grant is never one click); the Yes carries the folder it showed. Without the server's offer (a Hub viewer, a folder Coral may not trust),
// for a look-alike menu or a folder with a hidden character, only No is a button. The chat reply and the answer route are stubbed. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const FOLDER = '/Users/qa/work/a-very-long-folder-name-for-a-project-that-keeps-going/and-deeper/still-deeper/project';
const MENU = (extra = {}) => ({ question: 'Quick safety check: Is this a project you created or one you trust?', ask_id: 'trust-ask', unnumbered: true, options: [{ n: 1, label: 'No, exit', action: 'select' }, { n: 2, label: 'Yes, I trust this folder', action: 'select' }], trust_folder: FOLDER, trust_offer: true, ...extra });

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const MOD = `(window.__coralStatic || '/static/')`;
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`window.__posts = []; window.__status = 200; window.__po = ${JSON.stringify(MENU())};
                const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u), m = (o.method || 'GET').toUpperCase();
                    if (m === 'POST' && /\\/answer-prompt$/.test(url)) { window.__posts.push(JSON.parse(o.body)); return Promise.resolve(new Response(JSON.stringify(window.__status === 200 ? { ok: true } : { code: 'trust_changed', error: 'The folder to trust changed.' }), { status: window.__status, headers: { 'Content-Type': 'application/json' } })); }
                    if (m === 'GET' && /\\/api\\/sessions\\/live\\/[^/]+\\/chat\\?/.test(url)) return Promise.resolve(new Response(JSON.stringify({ messages: [], total: 0, prompt_options: window.__po }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                    return real(u, o); };
                true`);
            let n = 0;
            const draw = () => ev(`(async () => { const m = await import(${MOD} + 'inbox_answer.js'); document.querySelectorAll('.t-cell').forEach(e => e.remove()); const box = document.createElement('div'); box.className = 't-cell'; box.style.cssText = 'position:fixed;top:60px;left:8px;right:8px;z-index:9999;background:var(--bg-primary,#fff);padding:8px';
                const cell = m.answerCell({ name: 'claude-t${++n}', session_id: 'sess-t${n}', agent_type: 'claude', waiting_since: 'w${n}' }); box.append(cell); document.body.append(box); window.__cell = cell; return true; })()`);
            const labels = () => ev(`[...window.__cell.querySelectorAll('button:not(.inbox-dismiss)')].map(b => b.textContent)`);
            const press = text => ev(`(() => { const b = [...window.__cell.querySelectorAll('button')].find(x => x.textContent === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);
            const settle = () => waitFor(`window.__cell.querySelectorAll('button:not(.inbox-dismiss)').length > 0`, `${at}the choices are drawn`, 8000);

            // 1) offered: both choices, the folder as plain text, the line that says what Yes does
            await draw(); await settle();
            assert.deepEqual(await labels(), ['No, exit', 'Yes, I trust this folder'], `${at}No and Yes are the buttons`);
            const note = await ev(`(() => { const n = window.__cell.querySelector('.inbox-trust-note'), c = n && n.querySelector('code.inbox-trust-path'); return n && { text: n.textContent, path: c && c.textContent, html: n.innerHTML.includes('<') && !c }; })()`);
            check(note && note.path === FOLDER && /adds this folder to Claude.s own trust list/.test(note.text), `${at}the folder and what Yes does are on the row: ` + JSON.stringify(note));
            if (mobile) {
                const geo = await ev(`(() => { const r = [...window.__cell.querySelectorAll('button:not(.inbox-dismiss)')].map(b => Math.round(b.getBoundingClientRect().height)); return { heights: r, wide: document.documentElement.scrollWidth > innerWidth }; })()`);
                check(geo.heights.every(x => x >= 44) && !geo.wide, `${at}the buttons are 44 px and the long folder does not widen the page: ` + JSON.stringify(geo));
            }

            // 2) Yes asks once more and sends nothing; Cancel draws the choices again; the second press sends the folder
            await press('Yes, I trust this folder');
            await waitFor(`!!window.__cell.querySelector('.inbox-trust-confirm')`, `${at}Yes asks once more`, 5000);
            const ask = await ev(`(() => { const q = window.__cell.querySelector('.inbox-trust-confirm'); return { text: q.textContent, path: q.querySelector('code').textContent, buttons: [...window.__cell.querySelectorAll('button')].map(b => b.textContent), focus: document.activeElement && document.activeElement.textContent, posts: window.__posts.length }; })()`);
            check(ask.text === `Trust ${FOLDER} for Claude, for every agent that starts there?` && ask.path === FOLDER, `${at}the question names the folder: ` + JSON.stringify(ask));
            check(ask.buttons.includes('Trust this folder') && ask.buttons.includes('Cancel') && ask.posts === 0 && ask.focus === 'Cancel', `${at}nothing is sent yet and the keyboard is on Cancel: ` + JSON.stringify(ask));
            await press('Cancel'); await settle();
            assert.deepEqual(await labels(), ['No, exit', 'Yes, I trust this folder'], `${at}Cancel draws the choices again`);
            assert.equal(await ev(`window.__posts.length`), 0, `${at}Cancel sent nothing`);
            await press('Yes, I trust this folder'); await waitFor(`!!window.__cell.querySelector('.inbox-trust-confirm')`, `${at}asks again`, 5000);
            await press('Trust this folder');
            await waitFor(`window.__posts.length === 1`, `${at}the second press sends the answer`, 5000);
            const sent = await ev(`window.__posts[0]`);
            check(sent.n === 2 && sent.label === 'Yes, I trust this folder' && sent.trust_folder === FOLDER && sent.ask_id === 'trust-ask', `${at}the Yes carries the folder it showed: ` + JSON.stringify(sent));

            // 3) No is one press and sends no folder
            await ev(`window.__posts = []; true`); await draw(); await settle();
            await press('No, exit');
            await waitFor(`window.__posts.length === 1`, `${at}No is sent at once`, 5000);
            const no = await ev(`window.__posts[0]`);
            check(no.n === 1 && !('trust_folder' in no) && !(await ev(`!!window.__cell.querySelector('.inbox-trust-confirm')`)), `${at}No is one press with no confirm and no folder: ` + JSON.stringify(no));

            // 4) not offered (the Hub, a folder Coral may not trust), a look-alike menu, a folder with a hidden character: only No
            const cases = {
                'no offer': MENU({ trust_offer: false }),
                'no folder': MENU({ trust_folder: '' }),
                'a hidden character in the folder': MENU({ trust_folder: '/Users/qa/work/pro\u202Eject' }),
                'a lasting Yes with other words': MENU({ options: [{ n: 1, label: 'No, exit', action: 'select' }, { n: 2, label: 'Yes, always trust this folder', action: 'select' }] }),
                'a third option': MENU({ options: [{ n: 1, label: 'No, exit', action: 'select' }, { n: 2, label: 'Yes, I trust this folder', action: 'select' }, { n: 3, label: 'Yes, and every folder under it', action: 'select' }] }),
            };
            for (const [name, po] of Object.entries(cases)) {
                await ev(`window.__posts = []; window.__po = ${JSON.stringify(po)}; true`); await draw();
                await waitFor(`window.__cell.querySelectorAll('button').length > 0`, `${at}${name}: the row`, 8000);
                const got = await labels();
                check(!got.some(l => /trust/i.test(l)), `${at}${name}: no Yes button: ` + JSON.stringify(got));
                if (name === 'no offer' || name === 'no folder' || name === 'a hidden character in the folder') check(JSON.stringify(got) === JSON.stringify(['No, exit']) && /open the agent/i.test(await ev(`window.__cell.textContent`)), `${at}${name}: No only, and the rest is left to Open: ` + JSON.stringify(got));
            }

            // 5) the server refuses the Yes (the folder changed): nothing is claimed, the choices are drawn again, the person is told
            await ev(`window.__posts = []; window.__status = 409; window.__po = ${JSON.stringify(MENU())}; true`); await draw(); await settle();
            await press('Yes, I trust this folder'); await waitFor(`!!window.__cell.querySelector('.inbox-trust-confirm')`, `${at}asks`, 5000);
            await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); true`);
            await press('Trust this folder');
            await waitFor(`[...document.querySelectorAll('.toast .toast-message')].some(e => /folder to trust changed/.test(e.textContent))`, `${at}the refusal is told`, 8000);
            check(!/Answered/.test(await ev(`window.__cell.textContent`)), `${at}a refused Yes is not Answered`);
            await ev(`window.__status = 200; true`);
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS a row answers the folder-trust prompt: both choices, the folder as text, a second press before Yes, no Yes unless offered, at 1280 and 390');
})().catch(e => { console.error(e); process.exit(1); });
