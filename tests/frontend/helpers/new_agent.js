// What the New Agent and Restart Session dialogs of the redesign (#7374, #7376; UI/UX's IA v4 notes a8d59b25, mockup c5294957) are looked up by in the new suites: the dialog's role and name, a control's
// accessible name or visible text, never an id or a class, so the build can name its elements as it likes while the person-visible and screen-reader-visible shape is what is tested.
// install(ev) puts window.__na in the page: dialog() is the visible role=dialog whose name starts with "New agent" or "Restart" (the exact names are asserted by their own scenarios); find(selector, regexp) the visible control in it whose accessible name matches.
const SOURCE = `(() => {
    // Shown to a person: has a box, is not visibility:hidden, and is not the content of a closed <details> (its summary stays shown).
    const inClosedDetails = e => { for (let d = e.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) { if (!d.open) { const sm = e.closest('summary'); if (!(sm && sm.parentElement === d)) return true; } } return false; };
    const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && !inClosedDetails(e);
    // Text as a screen reader gets it: a part that is aria-hidden (an icon's ligature name, an initial in a dot) is left out, and blocks and buttons are separated.
    const text = e => { let out = ''; const walk = n => { if (n.nodeType === 3) { out += n.textContent; return; } if (n.nodeType !== 1 || n.getAttribute('aria-hidden') === 'true' || n.hidden) return; const block = /^(DIV|P|LI|LABEL|BUTTON|H[1-6]|SECTION|OPTION|SUMMARY|TD|TH|TR)$/.test(n.tagName); if (block) out += ' '; for (const c of n.childNodes) walk(c); if (block) out += ' '; }; walk(e); return out.replace(/\\s+/g, ' ').trim(); };
    const name = e => {
        const l = e.getAttribute('aria-label'); if (l) return l.trim();
        const by = e.getAttribute('aria-labelledby');
        if (by) return by.split(/\\s+/).map(i => { const n = document.getElementById(i); return n ? text(n) : ''; }).join(' ').trim();
        if (e.id) { const lab = document.querySelector('label[for="' + CSS.escape(e.id) + '"]'); if (lab) return text(lab); }
        if (e.tagName !== 'BUTTON' && e.closest('label')) return text(e.closest('label'));
        return text(e);
    };
    const dialog = () => [...document.querySelectorAll('[role=dialog]')].filter(vis).find(d => /^(New agent|Restart)/i.test(name(d))) || null;
    const find = (sel, rx) => { const d = dialog(); return d ? [...d.querySelectorAll(sel)].filter(vis).find(e => rx.test(name(e))) || null : null; };
    // The dialog's visible panel: role=dialog may be a full-screen backdrop that holds the panel (.modal-content), so the panel is measured, not the backdrop.
    const panel = () => { const d = dialog(); if (!d) return null; const r = d.getBoundingClientRect(); const full = r.width >= innerWidth - 1 && r.height >= innerHeight - 1; const c = full ? [...d.children].find(e => vis(e) && e.getBoundingClientRect().width > 100) : null; return c || d; };
    // A choice of a radiogroup: a role=radio button or a native radio input; checked by aria-checked or the input's own state.
    const radios = g => [...g.querySelectorAll('[role=radio], input[type=radio]')];
    const isChecked = r => r.getAttribute('aria-checked') === 'true' || (r.type === 'radio' && r.checked);
    const radioName = r => { const n = name(r); if (n) return n; const l = r.closest('label'); return l ? text(l) : ''; };
    const box = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; };
    const buttons = () => { const d = dialog(); return d ? [...d.querySelectorAll('button')].filter(vis).map(b => ({ name: name(b), ...box(b), disabled: b.disabled, ariaDisabled: b.getAttribute('aria-disabled') })) : []; };
    window.__na = { vis, name, text, dialog, find, box, buttons, panel, radios, isChecked, radioName };
    return true;
})()`;
const install = ev => ev(SOURCE);

// The accessible names the design gives its controls (IA v4 and the mockup): the tests say them once.
const N = {
    dialogNew: /^New agent$/i, dialogRestart: /^Restart .+$/i, // "Restart <the agent's name>" (#7886)
    folder: /^Folder/i, recents: /^Recent folders$/i, machine: /^Machine$/i,
    persona: /persona/i, name: /^Name/i, prompt: /^Instructions for this agent$/i,
    provider: /^Provider$/i, model: /^Model$/i, thinking: /^Thinking/i, mode: /mode$/i, flags: /^Flags/i,
    cancel: /^Cancel$/i, back: /^Back$/i, next: /^Next$/i, launch: /^Launch$/i, restart: /^Restart$/i,
    tabs: ['Agent', 'Permissions', 'Advanced'], restartTabs: ['Agent', 'Persona', 'Permissions', 'Advanced'],
};

// Open New agent as a person does: the Launch dialog, then the Agent choice if the dialog asks first. Resolves once the dialog is there (or after the wait, so a failing build reports what is missing).
async function openNewAgent(ev, waitFor) {
    await ev(`(async () => { await window.showLaunchModal(); const c = document.querySelector('#launch-step-chooser [data-arg="agent"]'); if (c && c.getClientRects().length) c.click(); return true; })()`);
    await waitFor(`!!window.__na.dialog()`, 'the New agent dialog (role=dialog named New agent)', 6000);
}
const stepLine = ev => ev(`(() => { const d = window.__na.dialog(); if (!d) return ''; const hits = [...d.querySelectorAll('*')].filter(window.__na.vis).map(e => window.__na.text(e)).filter(t => /^Step \\d of 3: /.test(t)); hits.sort((a, b) => a.length - b.length); return hits[0] || ''; })()`);

// A scenario list that reports every one, not the first: a failing-first suite says what is missing in each place.
function scenarios() {
    const results = [];
    return {
        async run(name, fn) { try { await fn(); results.push([name, null]); console.log('   ok   ' + name); } catch (e) { results.push([name, e]); let m = String((e && e.message) || e).split('\n')[0]; if (/Uncaught/.test(m) && /Cannot (read|set) properties of null/.test(m)) m = 'the dialog or a control the design names is missing (a null in the page: ' + (m.match(/TypeError: [^\\"]{0,80}/) || [''])[0] + ')'; console.log('   FAIL ' + name + ': ' + m.slice(0, 300)); } },
        finish() { const bad = results.filter(r => r[1]); console.log(`${results.length - bad.length}/${results.length} scenarios pass`); if (bad.length) { console.error(`FAIL: ${bad.length} scenario(s): ` + bad.map(r => r[0]).join('; ')); process.exit(1); } },
    };
}
// Models and levels for every provider, so a form has something to choose (the page asks GET /api/agents/models?type=<provider>).
const stubModels = ev => ev(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('coral-models:v1:')) localStorage.removeItem(k);
    const R = window.fetch; const LEVELS = ['low', 'medium', 'high'];
    window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
        if (url.pathname.startsWith('/api/agents/models')) { const t = url.searchParams.get('type') || 'claude'; return Promise.resolve(new Response(JSON.stringify({ agent_type: t, fetched_at: '2026-10-25T00:00:00Z', refreshing: false, source: 'account', models: [{ value: t + '-big', display_name: t + ' Big', efforts: LEVELS }, { value: t + '-small', display_name: t + ' Small', efforts: LEVELS }], thinking: LEVELS }), { status: 200, headers: { 'content-type': 'application/json' } })); }
        return R(u, o); };
    return true; })()`);
module.exports = { stubModels, SOURCE, install, N, openNewAgent, stepLine, scenarios };
