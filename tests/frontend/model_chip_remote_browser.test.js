// The model chip on a REMOTE computer (#13785, a gap in #13761): real clicks on the chat box's model chip and thinking chip change an agent on another computer through the Hub, and a refusal says which computer
// refused and what to do about THAT computer. The Hub and the remote computers are stubbed (the server list the Hub knows, and the remote's answer to POST /api/remote/<id>/api/sessions/live/<name>/model):
//   - success: a click on a model and on a thinking level sends {model} / {thinking} to that computer's route (never to this one's), and the chip says it is switching, with no error toast;
//   - refusal 403 operator_only, one per kind of computer: one whose owner stamp works (sign in, update Coral on it); one set up over SSH (press Set up approvals for it); one added by address (press Approve through this
//     hub for it); one the list does not describe (its own words, behind its name);
//   - this computer's own refusal is as it came, with no computer named.
// 1280 and 390 px. The refusal words themselves are pinned by model_chip_refused.test.mjs; this is the click through the page. Isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

const LEVELS = ['low', 'medium', 'high'];
const OPUS = { value: 'claude-opus-5-5', display_name: 'Opus 5.5', efforts: LEVELS };
const SONNET = { value: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5', efforts: LEVELS };
const REFUSAL = { code: 'operator_only', error: "this computer changes an agent's model only for a person at its own dashboard" };
const COMPUTERS = [ // [agent, server id, the Hub's row for it, what the refusal must say]
    ['rm-stamp', 'm1', { id: 'm1', label: 'build-box', owner_stamp: true, transport: 'ssh' }, [/^build-box did not take the change:/, /signed-in person/, /update Coral on build-box/, /^(?!.*Set up approvals)/]],
    ['rm-ssh', 'm4', { id: 'm4', label: 'fresh-ssh', transport: 'ssh' }, [/^fresh-ssh did not take the change:/, /approvals are not set up/, /press Set up approvals for fresh-ssh/]],
    ['rm-addr', 'm3', { id: 'm3', label: 'by-address', transport: 'tcp' }, [/^by-address did not take the change:/, /press Approve through this hub for by-address/, /^(?!.*Set up approvals)/]],
    ['rm-unk', 'm5', { id: 'm5', label: 'unknown-shape' }, [/^unknown-shape did not take the change: this computer changes an agent's model only for a person at its own dashboard$/]],
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            await ev(`localStorage.clear(); localStorage.setItem('coral-live-view-mode', 'chat'); true`);
            await ev(`(() => { const R = window.fetch; window.__posts = []; window.__answer = { status: 202, body: { ok: true } };
                const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
                window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); const m = (o.method || 'GET').toUpperCase();
                    if (/\\/api\\/agents\\/models$/.test(url.pathname)) return Promise.resolve(json({ agent_type: 'claude', models: [${JSON.stringify(OPUS)}, ${JSON.stringify(SONNET)}], thinking: ${JSON.stringify(LEVELS)} }));
                    if (/\\/api\\/sessions\\/live\\/[^/]+\\/model$/.test(url.pathname) && m === 'POST') { window.__posts.push({ path: url.pathname, body: JSON.parse(o.body) }); return Promise.resolve(json(window.__answer.body, window.__answer.status)); }
                    return R(u, o); };
                T.state.servers = ${JSON.stringify(COMPUTERS.map(c => c[2]))};
                ${JSON.stringify(COMPUTERS.map(c => [c[0], c[1]]))}.forEach(([n, s]) => window.__m.add(n, n.slice(-1).toUpperCase(), 3, { sleeping: false, agent_type: 'claude', server: s }));
                window.__m.add('rm-local', 'L', 3, { sleeping: false, agent_type: 'claude' });
                T.render.renderLiveSessions(T.state.liveSessions); return true; })()`);
            const feed = (id, server) => ev(`(() => { const a = window.__m.agents[${JSON.stringify(id)}]; T.ws.handleCoralMessage({ type: 'coral_diff', changed: [{ ...window.__m.entry(a), agent_type: 'claude', model: ${JSON.stringify(OPUS.value)}, thinking_actual: 'high', server: ${JSON.stringify(server)} }] }); return true; })()`);
            const openMenu = async kind => { await ev(`document.getElementById(${JSON.stringify(kind + '-chip')}).click(); true`); await waitFor(`!document.getElementById(${JSON.stringify(kind + '-chip-menu')}).hidden && document.querySelectorAll(${JSON.stringify('#' + kind + '-chip-menu .model-chip-item')}).length > 0`, `${at}the ${kind} menu opens`, 8000); };
            const toasts = () => ev(`[...document.querySelectorAll('.toast')].map(e => e.textContent.trim())`);
            const clearToasts = () => ev(`document.querySelectorAll('#toast-host > *, .toast').forEach(e => e.remove()); true`);
            const setServers = () => ev(`import((window.__coralStatic || '/static/') + 'state.js').then(({ state }) => { state.hub = true; state.servers = ${JSON.stringify(COMPUTERS.map(c => c[2]))}; return true; })`); // the Hub's list: the page's own refresh of the live list replaces it
            const choose = async (kind, sel, answer) => {
                await ev(`window.__answer = ${JSON.stringify(answer)}; window.__posts = []; true`); await clearToasts();
                await setServers();
                await openMenu(kind);
                await setServers();
                await ev(`document.querySelector(${JSON.stringify('#' + kind + '-chip-menu ' + sel)}).click(); true`);
                await waitFor(`window.__posts.length > 0`, `${at}the ${kind} choice is sent`, 8000);
                if (answer.status !== 202) await waitFor(`!!document.querySelector('.toast')`, `${at}the refusal is told`, 8000);
                return { post: (await ev(`window.__posts[0]`)), toasts: await toasts() };
            };
            for (const [name, server, , words] of COMPUTERS) {
                const id = name + '-id';
                await select(name, server);
                await feed(id, server);
                await waitFor(`!document.getElementById('model-chip-bar').hidden && document.getElementById('model-chip-text').textContent.includes('Opus')`, `${at}${name}: the chip shows the model`, 10000).catch(() => {});
                // a model click: refused, in that computer's words
                const m = await choose('model', `[data-model="${SONNET.value}"]`, { status: 403, body: REFUSAL });
                check(m.post.path === `/api/remote/${server}/api/sessions/live/${name}/model` && m.post.body.model === SONNET.value, `${at}${name}: the model choice goes to ${server}'s route: ` + JSON.stringify(m.post));
                check(m.toasts.some(t => words.every(re => re.test(t))), `${at}${name}: the refusal says which computer and what to do: ` + JSON.stringify(m.toasts));
                // a thinking click: the same words
                const t = await choose('thinking', '[data-level="low"]', { status: 403, body: REFUSAL });
                check(t.post.path === `/api/remote/${server}/api/sessions/live/${name}/model` && t.post.body.thinking === 'low', `${at}${name}: the thinking choice goes to ${server}'s route: ` + JSON.stringify(t.post));
                check(t.toasts.some(x => words.every(re => re.test(x))), `${at}${name}: and its refusal says the same: ` + JSON.stringify(t.toasts));
                if (server === 'm1' && !mobile) await shot('model-chip-remote-refused-1280');
                if (server === 'm1' && mobile) await shot('model-chip-remote-refused-390');
            }
            // success on the computer whose stamp works: sent to its route, the chip says it is switching, no error
            await select('rm-stamp', 'm1'); await feed('rm-stamp-id', 'm1');
            await waitFor(`!document.getElementById('model-chip-bar').hidden`, `${at}the chip for the success`, 10000).catch(() => {});
            const ok = await choose('model', `[data-model="${SONNET.value}"]`, { status: 202, body: { ok: true } });
            check(ok.post.path === '/api/remote/m1/api/sessions/live/rm-stamp/model' && ok.post.body.model === SONNET.value && ok.post.body.agent_type === 'claude', `${at}success: the model is sent to m1: ` + JSON.stringify(ok.post));
            check(/Switching to Sonnet 5\.5/.test(await ev(`document.getElementById('model-chip-text').textContent + ' ' + (document.getElementById('model-chip-note') || {}).textContent`)), `${at}success: the chip says it is switching: ` + await ev(`document.getElementById('model-chip-text').textContent`));
            check(!(await toasts()).some(x => /did not take the change/.test(x)), `${at}success: no refusal toast: ` + JSON.stringify(await toasts()));
            const ok2 = await choose('thinking', '[data-level="medium"]', { status: 202, body: { ok: true } });
            check(ok2.post.path === '/api/remote/m1/api/sessions/live/rm-stamp/model' && ok2.post.body.thinking === 'medium', `${at}success: the level is sent to m1: ` + JSON.stringify(ok2.post));
            // this computer's own refusal is as it came
            await select('rm-local', 'local'); await feed('rm-local-id', 'local');
            await waitFor(`!document.getElementById('model-chip-bar').hidden`, `${at}the chip for this computer`, 10000).catch(() => {});
            const own = await choose('model', `[data-model="${SONNET.value}"]`, { status: 403, body: REFUSAL });
            check(own.post.path === '/api/sessions/live/rm-local/model' && own.toasts.some(x => x === REFUSAL.error), `${at}this computer's own refusal is as it came, naming no computer: ` + JSON.stringify([own.post.path, own.toasts]));
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('PASS the model and thinking chips change a remote agent, and a refusal names that computer, at 1280 and 390');
})().catch(e => { console.error(e); process.exit(1); });
