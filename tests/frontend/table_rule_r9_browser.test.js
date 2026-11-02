// R9 of the table rules (a row's action buttons sit in the Actions column only): an agent's name link (.agent-link, #12168) is navigation, not a row action, so it may sit in a data column;
// a real action button in a data column is still a violation, and so is one that merely looks like a link by its words. The audit and the judge are the ones table_rules_browser uses.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { AUDIT, judge } = require('./helpers/table_rules');

(async () => {
    const { client, Page, ev, PRELOAD, install } = await connect();
    const failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        const audit = async cells => {
            await ev(`(() => { document.getElementById('r9-box')?.remove(); const b = document.createElement('div'); b.id = 'r9-box'; b.style.cssText = 'position:fixed;top:60px;left:20px;width:900px;background:#222;z-index:99999';
                b.innerHTML = '<table class="dt-table"><thead><tr><th class="dt-th" data-key="agent">Agent</th><th class="dt-th" data-key="actions">Actions</th></tr></thead><tbody><tr class="dt-row"><td data-key="agent">' + ${JSON.stringify(cells)} + '</td><td data-key="actions"></td></tr></tbody></table>'; document.body.append(b); return true; })()`);
            return ev(`(${AUDIT})(document.getElementById('r9-box'))`);
        };
        const link = await audit('<button type="button" class="agent-name agent-link" data-agent-link="s1" aria-label="Open Orchestrator">Orchestrator</button>');
        check(judge(link).every(v => !/^R9/.test(v)) && link.buttons.length === 0, 'an agent link in a data column is not a row action: ' + JSON.stringify([link.buttons, judge(link)]));
        const real = await audit('<button type="button" class="btn btn-small">Dismiss</button>');
        check(judge(real).some(v => /^R9: the button "Dismiss" sits in the "agent" column/.test(v)), 'a real action button in a data column is still caught: ' + JSON.stringify(judge(real)));
        const lookalike = await audit('<button type="button" class="btn btn-small">Open Orchestrator</button>');
        check(judge(lookalike).some(v => /^R9/.test(v)), 'a button that only says "Open Orchestrator" (no agent-link class) is caught: exempted by class, not by words: ' + JSON.stringify(judge(lookalike)));
        const both = await audit('<button type="button" class="agent-name agent-link">Orchestrator</button> <button type="button" class="btn btn-small">Ignore</button>');
        check(judge(both).filter(v => /^R9/.test(v)).length === 1, 'beside a link, the real action is the one caught: ' + JSON.stringify(judge(both)));
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n' + failures.join('\n')); process.exitCode = 1; } else console.log('PASS R9: an agent link is not a row action; a real action in a data column is');
})().catch(e => { console.error(e); process.exitCode = 1; });
