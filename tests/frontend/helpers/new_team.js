// What the New team dialog and its Edit member dialog (the team launch redesign, #7407; UI/UX's final v4 doc ad146b3a and mockup 25717f66) are looked up by in the new_team_* suites: role and accessible name, never an id or
// a class. Builds on helpers/new_agent.js (its __na has the name, text, vis and box functions); install(ev) adds window.__nt: dlg(rx) is the visible role=dialog whose name matches, find(dlg, selector, rx) the visible
// control in it, rows(dlg) the member rows (the buttons named "Edit <role>: <provider>, <model>"), roles(dlg) their role names in order.
const na = require('./new_agent');
const SOURCE = `(() => {
    const A = window.__na;
    const dlg = rx => [...document.querySelectorAll('[role=dialog]')].filter(A.vis).find(d => rx.test(A.name(d))) || null;
    const find = (d, sel, rx) => d ? [...d.querySelectorAll(sel)].filter(A.vis).find(e => rx.test(A.name(e))) || null : null;
    const rows = d => d ? [...d.querySelectorAll('button')].filter(A.vis).filter(b => /^Edit .+: /.test(A.name(b)) && !/^Edit member/.test(A.name(b))) : [];
    const roles = d => rows(d).map(b => A.name(b).replace(/^Edit /, '').replace(/: .*$/, ''));
    const panel = d => { if (!d) return null; const r = d.getBoundingClientRect(); const full = r.width >= innerWidth - 1 && r.height >= innerHeight - 1; const c = full ? [...d.children].find(e => A.vis(e) && e.getBoundingClientRect().width > 100) : null; return c || d; };
    const buttons = d => d ? [...d.querySelectorAll('button')].filter(A.vis).map(b => ({ name: A.name(b), ...A.box(b), disabled: b.disabled, ariaDisabled: b.getAttribute('aria-disabled') })) : [];
    window.__nt = { dlg, find, rows, roles, panel, buttons };
    return true;
})()`;
const install = async ev => { await na.install(ev); return ev(SOURCE); };
const N = {
    team: /^New team$/i, member: /^Edit member/i,
    teamName: /^Team name/i, folder: /^Folder/i, recents: /^Recent folders$/i, machine: /^Machine$/i, address: /^Another computer's address$/i,
    template: /template/i, bulk: /^Set all workers to/i, section: /section$/i,
    cancel: /^Cancel$/i, back: /^Back$/i, next: /^Next$/i, launch: /^Launch team$/i, save: /^Save member$/i, addMember: /^\+?\s*Add member$/i, addOrch: /^Add Orchestrator$/i,
    tabs: ['Start', 'Workflow', 'Health check', 'Messaging'], memberTabs: ['Persona', 'Agent', 'Permissions', 'Advanced'],
};
const stepLine = ev => ev(`(() => { const d = window.__nt.dlg(${N.team}); if (!d) return ''; const hits = [...d.querySelectorAll('*')].map(e => window.__na.text(e)).filter(t => /^Step \\d of 3: /.test(t)); hits.sort((a, b) => a.length - b.length); return hits[0] || ''; })()`);
// Open New team as a person does: the Launch dialog, then the Team choice.
async function openNewTeam(ev, waitFor) {
    await ev(`(async () => { await window.showLaunchModal(); const c = document.querySelector('#launch-step-chooser [data-arg="team"]'); if (c && c.getClientRects().length) c.click(); return true; })()`);
    await waitFor(`!!window.__nt.dlg(${N.team})`, 'the New team dialog (role=dialog named New team)', 6000);
}
// The steps of the flow, the same in every suite: T(ev, waitFor) gives click(sel, rx), type(sel, rx, value), pick(select, text) and to(step, opts) that fills what each step needs and presses Next.
const T = (ev, waitFor) => {
    const t = {
        click: async (sel, rx, within = N.team) => { assert_(await ev(`(() => { const e = window.__nt.find(window.__nt.dlg(${within}), ${JSON.stringify(sel)}, ${rx}); if (!e) return false; e.click(); return true; })()`), `no visible ${sel} named ${rx} in the dialog`); },
        type: (sel, rx, v, within = N.team) => ev(`(() => { const e = window.__nt.find(window.__nt.dlg(${within}), ${JSON.stringify(sel)}, ${rx}); if (!e) return false; e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`),
        has: (sel, rx, within = N.team) => ev(`!!window.__nt.find(window.__nt.dlg(${within}), ${JSON.stringify(sel)}, ${rx})`),
        pick: (rx, text, within = N.team) => ev(`(() => { const s = window.__nt.find(window.__nt.dlg(${within}), 'select', ${rx}); if (!s) return false; const o = [...s.options].find(o => ${text}.test(o.textContent)); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`),
        step: n => waitFor(`/^Step ${n} of 3/.test((() => { const d = window.__nt.dlg(${N.team}); return d ? [...d.querySelectorAll('*')].map(e => window.__na.text(e)).filter(x => /^Step \\d of 3: /.test(x)).sort((a, b) => a.length - b.length)[0] || '' : ''; })())`, `step ${n} of 3`, 5000),
        to: async (n, { name = 'alpha', folder = '/work/payments-app', template = /Coding|Blank/ } = {}) => {
            await t.type('input', N.teamName, name); await t.type('input', N.folder, folder);
            if (n >= 2) { await t.click('button', N.next); await t.step(2); }
            if (n >= 3) { if (template) await t.pick(N.template, template); await t.click('button', N.next); await t.step(3); }
        },
        rect: () => ev(`(() => { const p = window.__nt.panel(window.__nt.dlg(${N.team})); return p ? window.__na.box(p) : null; })()`),
    };
    return t;
};
function assert_(ok, msg) { if (!ok) throw new Error(msg); }
module.exports = { T, SOURCE, install, N, stepLine, openNewTeam, scenarios: na.scenarios, stubModels: na.stubModels };
