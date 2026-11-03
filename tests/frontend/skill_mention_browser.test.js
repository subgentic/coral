// $ in the composer opens the approved skills like @ opens files (#12677, the Operator): "$" at a word start lists them, the words after it filter (the search route), each row is a name and its one line, the
// arrow keys and Enter or a tap pick, a pick attaches the skill to THIS agent and puts the route's line where "$words" was. "$PATH" in a command opens nothing, Escape closes it and keeps the text, no approved
// skills says so with a way to the Skills Store, and a phone's rows are 44 px. The two routes are stood in in the page so no skill is attached. 1280 and 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const SKILLS = [
    { id: 'a'.repeat(32), name: 'abstract-review', version: 2, description: 'Review a change for what it hides' },
    { id: 'b'.repeat(32), name: 'abacus-math', version: 1, description: 'Do sums with care' },
    { id: 'c'.repeat(32), name: 'release-notes', version: 1, description: 'Write the release notes' },
];
const STUB = `(() => { window.__skillSearches = []; window.__skillAttach = []; window.__skillMode = 'some'; const R = window.fetch; const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
    window.fetch = (u, o) => { const url = new URL(String(u), location.href);
        if (url.pathname === '/api/skills/search') { const q = (url.searchParams.get('q') || '').toLowerCase(); window.__skillSearches.push(q);
            const all = ${JSON.stringify(SKILLS)}; return json({ skills: window.__skillMode === 'none' ? [] : all.filter(s => !q || (s.name + ' ' + s.description).toLowerCase().includes(q)) }); }
        if (/\\/api\\/sessions\\/live\\/[^/]+\\/skills$/.test(url.pathname) && o && o.method === 'POST') { const b = JSON.parse(o.body); window.__skillAttach.push({ path: url.pathname, session_id: url.searchParams.get('session_id'), skill_id: b.skill_id });
            const s = ${JSON.stringify(SKILLS)}.find(x => x.id === b.skill_id); return json({ ok: true, attached: true, line: 'Use the skill ' + s.name + ' (coral-agent skills get --id ' + s.id + ').' }); }
        return R(u, o); }; })();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const type = async text => { await ev(`document.getElementById('command-input').focus(); true`); await Input.insertText({ text }); };
    const clear = async () => { await ev(`document.getElementById('command-input').focus(); true`); await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'a', commands: ['selectAll'] }); await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Backspace', commands: ['deleteBackward'] }); };
    const key = async k => { const code = { ArrowDown: 40, Enter: 13, Escape: 27 }[k]; await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: code }); await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code }); };
    const menu = () => ev(`(() => { const d = document.querySelector('.skill-mention-dropdown'); if (!d || getComputedStyle(d).display === 'none') return null; return { rows: [...d.querySelectorAll('.skill-mention-item')].map(n => ({ text: n.textContent.trim().replace(/\\s+/g, ' '), selected: n.classList.contains('selected'), h: Math.round(n.getBoundingClientRect().height) })) }; })()`);
    const shown = n => `(() => { const d = document.querySelector('.skill-mention-dropdown'); return !!d && getComputedStyle(d).display !== 'none' && d.querySelectorAll('.skill-mention-item').length === ${n}; })()`;
    const closed = () => waitFor(`(() => { const d = document.querySelector('.skill-mention-dropdown'); return !d || getComputedStyle(d).display === 'none'; })()`, 'the skills menu to close', 3000);
    const value = () => ev(`document.getElementById('command-input').value`);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const tag = `${w} px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); window.__m.add('sk-a', 'A', 3, { sleeping: false, session_id: 'sk-a-id' }); window.selectLiveSession('sk-a', 'claude', 'sk-a-id', 'local'); true`);
            await waitFor(`!!document.getElementById('command-input') && !document.getElementById('command-input').disabled && !!document.querySelector('.skill-mention-dropdown')`, `${tag}: the composer and the skills menu`, 8000);

            // $ at a word start lists the skills: a name and its one line each
            await ev(`localStorage.clear(); true`); await clear(); // the last pass left its "$" as the box's draft
            await type('$');
            await waitFor(shown(3), `${tag}: the three skills`, 4000);
            let m = await menu();
            check(`${tag}: every approved skill with its description`, JSON.stringify(m.rows.map(r => r.text)) === JSON.stringify(['abstract-review Review a change for what it hides', 'abacus-math Do sums with care', 'release-notes Write the release notes']), JSON.stringify(m.rows));
            if (mobile) check(`${tag}: rows are 44 px under a finger`, m.rows.every(r => r.h >= 44), JSON.stringify(m.rows.map(r => r.h)));

            // the words filter; Enter attaches this agent's skill and inserts the line
            await type('ab');
            await waitFor(shown(2), `${tag}: "ab" narrows to two`, 4000);
            m = await menu(); await shot('skills-menu-' + w);
            check(`${tag}: $ab filters to the two that match`, m.rows.length === 2 && m.rows.every(r => /^ab/.test(r.text)) && m.rows[0].selected, JSON.stringify(m.rows));
            await key('ArrowDown');
            await waitFor(`document.querySelectorAll('.skill-mention-item')[1].classList.contains('selected')`, `${tag}: ArrowDown`, 3000);
            await key('Enter');
            await waitFor(`/Use the skill abacus-math/.test(document.getElementById('command-input').value)`, `${tag}: the line is inserted`, 4000);
            check(`${tag}: "$ab" is replaced by the route's line and a space`, (await value()) === 'Use the skill abacus-math (coral-agent skills get --id ' + 'b'.repeat(32) + ').' + ' ', await value());
            const att = await ev(`window.__skillAttach`);
            check(`${tag}: one attach, for this agent and the picked skill`, att.length === 1 && att[0].path === '/api/sessions/live/sk-a/skills' && att[0].session_id === 'sk-a-id' && att[0].skill_id === 'b'.repeat(32), JSON.stringify(att));
            await closed();

            // a tap picks too
            await clear(); await ev(`window.__skillAttach.length = 0; true`);
            await type('say $rel');
            await waitFor(shown(1), `${tag}: "$rel" in a sentence`, 4000);
            await ev(`document.querySelector('.skill-mention-item').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); true`);
            await waitFor(`/^say Use the skill release-notes/.test(document.getElementById('command-input').value)`, `${tag}: a tap attaches`, 4000);
            check(`${tag}: the text before $ stays`, /^say Use the skill release-notes \(coral-agent skills get --id c+\)\. $/.test(await value()), await value());

            // $PATH in a command opens nothing and attaches nothing; neither does a $ inside a word
            await clear(); await ev(`window.__skillAttach.length = 0; true`);
            await type('echo $PATH');
            await new Promise(r => setTimeout(r, 500)); // sleep-ok: nothing is the expected result; the search is debounced and its answer must not open a menu
            check(`${tag}: $PATH in a command opens no menu`, (await menu()) === null, JSON.stringify(await menu()));
            await clear(); await type('costs 5$ab and a$b');
            await new Promise(r => setTimeout(r, 500)); // sleep-ok: as above
            check(`${tag}: a $ inside a word opens no menu`, (await menu()) === null);
            check(`${tag}: and nothing was attached`, (await ev(`window.__skillAttach.length`)) === 0);

            // Escape closes it and leaves the text, and it stays closed while typing on
            await clear(); await type('$ab');
            await waitFor(shown(2), `${tag}: open again`, 4000);
            await key('Escape'); await closed();
            check(`${tag}: Escape leaves the text`, (await value()) === '$ab', await value());
            await type('s');
            await new Promise(r => setTimeout(r, 500)); // sleep-ok: the menu must stay closed; nothing to wait for
            check(`${tag}: it stays closed while the word goes on`, (await menu()) === null);

            // no approved skills: one row that says so and leads to the Skills Store
            await clear(); await ev(`window.__skillMode = 'none'; true`);
            await type('$');
            await waitFor(shown(1), `${tag}: the empty menu`, 4000);
            m = await menu();
            check(`${tag}: no approved skills says so`, /No approved skills yet/.test(m.rows[0].text) && /Skills Store/.test(m.rows[0].text), JSON.stringify(m.rows));
            await ev(`document.querySelector('.skill-mention-item').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); true`);
            await waitFor(`location.pathname === '/skills'`, `${tag}: the row opens the Skills Store`, 4000);
            await ev(`window.__skillMode = 'some'; true`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the $skill menu:\n  ' + problems.join('\n  '));
    console.log('PASS the $ skills menu: filter, attach and insert, $PATH, Escape, no skills, phone');
})().catch(e => { console.error(e); process.exit(1); });
