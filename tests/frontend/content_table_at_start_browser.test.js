// #10706 (QA Reviewer 2's rejection): content_table.css styles a table an author wrote in Markdown wherever one is shown (a chat bubble, a subagent's details, the generic .md, the file preview, Docs), so it is part of the start, not of Docs.
// At start, before Docs is visited, a table in a chat bubble and one in a .md block have their borders, padding and tokens. Isolated dev server over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            assert.ok(!(await ev(`!!document.getElementById('docs-view') && document.getElementById('docs-view').getClientRects().length > 0`)), `${w}: Docs has not been visited`);
            const look = await ev(`(() => {
                const host = document.createElement('div'); host.style.cssText = 'position:absolute;left:0;top:0';
                host.innerHTML = '<div class="chat-bubble"><div class="message-text" id="ct-bubble"><table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>Boss</td></tr></tbody></table></div></div><div class="md" id="ct-md"><table><tbody><tr><td>Plain</td></tr></tbody></table></div>';
                document.body.append(host);
                const read = sel => { const td = host.querySelector(sel + ' td'), cs = getComputedStyle(td); return { border: cs.borderTopStyle + ' ' + cs.borderTopWidth, padding: cs.paddingTop, token: getComputedStyle(host.querySelector(sel)).getPropertyValue('--content-table-display').trim() }; };
                const out = { bubble: read('#ct-bubble'), md: read('#ct-md') }; host.remove(); return out;
            })()`);
            for (const k of ['bubble', 'md']) {
                assert.equal(look[k].border, 'solid 1px', `${w}: a table in a ${k} has its cell border at start: ${JSON.stringify(look)}`);
                assert.notEqual(look[k].padding, '1px', `${w}: and not the browser's own cell padding: ${JSON.stringify(look)}`);
            }
            assert.equal(look.bubble.token, 'table', `${w}: the chat bubble sets its table display token: ${JSON.stringify(look)}`);
        }
        console.log('\nPASS a Markdown table is styled at start, before Docs is visited');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
