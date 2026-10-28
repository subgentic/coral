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
    const tablist = d => d ? [...d.querySelectorAll('[role=tablist]')].filter(A.vis)[0] || null : null; // the visible one: the Launch dialog holds New agent's step 3 tablist too, hidden
    window.__nt = { dlg, find, rows, roles, panel, buttons, tablist };
    return true;
})()`;
const install = async ev => { await na.install(ev); return ev(SOURCE); };
const N = {
    team: /^New project$/i, member: /^(Edit|Add) member/i,
    teamName: /^Team name/i, folder: /^Folder/i, recents: /^Recent folders$/i, machine: /^Machine$/i, address: /^Another computer's address$/i,
    template: /template/i, bulk: /^Set all workers to/i, section: /section$/i,
    cancel: /^Cancel$/i, back: /^Back$/i, next: /^Next$/i, launch: /^Launch team$/i, save: /^Save member$/i, addMember: /^\+?\s*Add member$/i, addOrch: /^Add Orchestrator$/i,
    tabs: ['Start', 'Workflow', 'Health check', 'Messaging'], memberTabs: ['Agent', 'Permissions', 'Advanced'], // the sections of a member's settings page; its role and prompt are the persona page before it (#7861)
};
const stepLine = ev => ev(`(() => { const d = window.__nt.dlg(${N.team}); if (!d) return ''; const hits = [...d.querySelectorAll('*')].filter(window.__na.vis).map(e => window.__na.text(e)).filter(t => /^Step \\d of 3: /.test(t)); hits.sort((a, b) => a.length - b.length); return hits[0] || ''; })()`);
// Open New team as a person does: the Launch dialog, then the Team choice.
async function openNewTeam(ev, waitFor) {
    await ev(`(async () => { await window.showLaunchModal(); const c = document.querySelector('#launch-step-chooser [data-arg="team"]'); if (c && c.getClientRects().length) c.click(); return true; })()`);
    await waitFor(`!!window.__nt.dlg(${N.team})`, 'the New project dialog (role=dialog named New project)', 6000);
}
// The steps of the flow, the same in every suite: T(ev, waitFor) gives click(sel, rx), type(sel, rx, value), pick(select, text) and to(step, opts) that fills what each step needs and presses Next.
const T = (ev, waitFor) => {
    const t = {
        click: async (sel, rx, within = N.team) => { assert_(await ev(`(() => { const e = window.__nt.find(window.__nt.dlg(${within}), ${JSON.stringify(sel)}, ${rx}); if (!e) return false; e.click(); return true; })()`), `no visible ${sel} named ${rx} in the dialog`); },
        type: (sel, rx, v, within = N.team) => ev(`(() => { const e = window.__nt.find(window.__nt.dlg(${within}), ${JSON.stringify(sel)}, ${rx}); if (!e) return false; e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`),
        has: (sel, rx, within = N.team) => ev(`!!window.__nt.find(window.__nt.dlg(${within}), ${JSON.stringify(sel)}, ${rx})`),
        pick: (rx, text, within = N.team) => ev(`(() => { const s = window.__nt.find(window.__nt.dlg(${within}), 'select', ${rx}); if (!s) return false; const o = [...s.options].find(o => ${text}.test(o.textContent)); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`),
        step: n => waitFor(`/^Step ${n} of 3/.test((() => { const d = window.__nt.dlg(${N.team}); return d ? [...d.querySelectorAll('*')].filter(window.__na.vis).map(e => window.__na.text(e)).filter(x => /^Step \\d of 3: /.test(x)).sort((a, b) => a.length - b.length)[0] || '' : ''; })())`, `step ${n} of 3`, 5000),
        // to(n): fills what each step needs and presses Next; a step that does not come up says which one, so a setup that fails is not swallowed (#7511: new_team_members had 4 of 9 scenarios red on Windows with an empty log).
        to: async (n, { name = 'alpha', folder = '/work/payments-app', template } = {}) => {
            const need = async (ok, what) => assert_(await ok, `the setup to step ${n} did not come up: ${what}`);
            const pickTemplate = async tpl => { const names = await ev(`(() => { const s = window.__nt.find(window.__nt.dlg(${N.team}), 'select', ${N.template}); return s ? [...s.options].map(o => o.textContent.trim()) : null; })()`); await need(t.pick(N.template, tpl), `no template named ${tpl} among ${JSON.stringify(names)}`); };
            await need(t.type('input', N.teamName, name), 'no Team name field'); await need(t.type('input', N.folder, folder), 'no Folder field');
            if (n >= 2) { await t.click('button', N.next); await t.step(2); if (n === 2 && template) await pickTemplate(template); }
            if (n >= 3) { const tpl = template === undefined ? /Coding/ : template; if (tpl) await pickTemplate(tpl); await t.click('button', N.next); await t.step(3); }
        },
        rect: () => ev(`(() => { const p = window.__nt.panel(window.__nt.dlg(${N.team})); return p ? window.__na.box(p) : null; })()`),
    };
    return t;
};
// The member dialog is the Launch dialog's agent step in a second mode (#7861): the same element as New team, so while it is open the team's own rows are hidden (dlg(N.team) is null). Add member opens on the persona page (the Role),
// Edit member on the settings page (sections Agent, Permissions, Advanced); Next and Back move between the two, and Save member is on the settings page.
const M = (ev, waitFor) => {
    const click = async (rx, what) => assert_(await ev(`(() => { const e = window.__nt.find(window.__nt.dlg(${N.member}), 'button', ${rx}); if (!e) return false; e.click(); return true; })()`), what);
    const m = {
        onPersona: () => ev(`!!window.__nt.find(window.__nt.dlg(${N.member}), 'input', /^Role$/i)`),
        open: () => ev(`!!window.__nt.dlg(${N.member})`),
        toPersona: async () => { if (!(await m.onPersona())) await click(N.back, 'no Back button to reach the persona page'); await waitFor(`!!window.__nt.find(window.__nt.dlg(${N.member}), 'input', /^Role$/i)`, 'the persona page (Role)', 4000); },
        toSettings: async () => { if (await m.onPersona()) await click(N.next, 'no Next button to reach the settings page'); await waitFor(`!!window.__nt.find(window.__nt.dlg(${N.member}), 'button', ${N.save})`, 'the settings page (Save member)', 4000); },
        setRole: async v => { await m.toPersona(); assert_(await ev(`(() => { const e = window.__nt.find(window.__nt.dlg(${N.member}), 'input', /^Role$/i); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`), 'no Role field'); },
        // a section of the settings page: a tab, or the Section select on a phone
        section: async name => { await m.toSettings(); await ev(`(() => { const d = window.__nt.dlg(${N.member}); const tab = [...d.querySelectorAll('[role=tab]')].filter(window.__na.vis).find(x => window.__na.name(x) === ${JSON.stringify(name)}); if (tab) { tab.click(); return true; } const s = window.__nt.find(d, 'select', ${N.section}); if (!s) return false; const o = [...s.options].find(o => o.textContent.trim() === ${JSON.stringify(name)}); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); },
        save: async () => { await m.toSettings(); await click(N.save, 'no Save member button'); await waitFor(`!window.__nt.dlg(${N.member}) && !!window.__nt.dlg(${N.team})`, 'Save member returns to New team', 4000); },
        cancel: async () => { await click(N.cancel, 'no Cancel button'); await waitFor(`!window.__nt.dlg(${N.member}) && !!window.__nt.dlg(${N.team})`, 'Cancel returns to New team', 4000); },
    };
    return m;
};
function assert_(ok, msg) { if (!ok) throw new Error(msg); }
module.exports = { T, M, SOURCE, install, N, stepLine, openNewTeam, scenarios: na.scenarios, stubModels: na.stubModels };
