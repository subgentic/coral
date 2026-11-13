/* New Agent's "Runs as" line (#7391, #15885): above the footer, the four values Launch will use as compact controls (see paintRecap), the warning for a risky mode and the exact flags under them. The controls are windows on the form's own
 * fields (the fields stay the one place that sets anything), so the line can never say one thing and the launch another. */
import { importOnce } from './import_once.js';
const { TYPE, fetchFlags, flagsNodes } = await importOnce('./permission_flags_line.js'); // the flags line is shared with Restart and Resume (#15761)
const { permissionDescription, permissionRisky, PI_NO_PERMISSIONS } = await importOnce('./permission_flags.js'); // lazy like launch_dialog.js: a lazy module is loaded through importOnce (import_hygiene)

const container = () => document.getElementById('launch-agent-acf');

/** What a permission mode allows for this CLI, in the words Settings and the Permissions tab use for it (Codex's Auto is its workspace sandbox with the network on; Antigravity's and Gemini's skip every prompt and check; Pi has no permissions at all): the footer says it, so 'Auto mode' is not left unexplained (Desktop tester, #10000). */
function modeNote(type, value, opt) { return (permissionDescription(type, value) || opt?.dataset.note || '').replace(/\.$/, ''); } // a mode the table does not know (a custom one) carries its own words in data-note

/** What the note under the line needs: the mode in words and what it allows for this CLI. */
function recapParts() {
    const acf = container();
    if (!acf) return null;
    const type = acf.querySelector('.acf-agent-type')?.value || 'claude';
    const modeSel = acf.querySelector('.acf-permission-mode');
    return {
        mode: modeSel ? (modeSel.options[modeSel.selectedIndex]?.textContent.trim() || '') : '',
        modeNote: modeSel ? modeNote(type, modeSel.value, modeSel.options[modeSel.selectedIndex]) : '',
        modeRisky: modeSel ? permissionRisky(type, modeSel.value) || modeSel.options[modeSel.selectedIndex]?.dataset.risky === '1' : false, // risk is the mode's own record (permissionRisky, or data-risky on a custom mode's option), not a pattern in its description
    };
}

/** Put the recap right for what the form holds now (the nodes are replaced only when the words changed). */
export function syncRecap() {
    paintRecap();
    syncFlags();
}

// The exact flags Coral adds for the chosen permissions (#15719), as the server's launch builders give them (POST /api/launch/permission-args: one source of truth, never a second copy here), in the recap's last line.
const flagsCache = new Map(); // request body -> the answer
let flagsShown = '', flagsTimer = 0, flagsSeq = 0;
function flagsBody() {
    const acf = container(), cfg = acf && window.getAgentConfig?.('launch-agent-acf');
    if (!cfg || !cfg.agentType || cfg.agentType === 'terminal') return null;
    return { agent_type: cfg.agentType, permission_mode: cfg.permissionMode || '', flags: String(cfg.flags || '').split(/\s+/).filter(Boolean), keep_full_access: !!cfg.useFullAccess, ...(cfg.capabilities ? { capabilities: cfg.capabilities } : {}) };
}
function paintFlags(answer, type) {
    const el = document.getElementById('launch-recap');
    if (!el) return;
    el.querySelectorAll('.launch-recap-flags').forEach(n => n.remove());
    el.append(...flagsNodes(answer, type)); // why what is added is not what the pick stands for (#15735): a role's rule, kept Full access, or Codex's own settings; the server says it
}
function syncFlags() {
    const body = flagsBody();
    if (!body) { flagsShown = ''; paintFlags(null); return; }
    const key = JSON.stringify(body);
    if (flagsCache.has(key)) { flagsShown = key; paintFlags(flagsCache.get(key), body.agent_type); return; }
    if (flagsShown !== key) { flagsShown = ''; paintFlags(null); } // the old answer is not this choice's: no line until the new one arrives, never a stale one
    clearTimeout(flagsTimer);
    const seq = ++flagsSeq;
    flagsTimer = setTimeout(async () => {
        const server = (await importOnce('./launch_models.js'))._acfServer(container());
        const answer = await fetchFlags(server, body);
        if (!answer) return; // no line: the recap above still says the mode
        flagsCache.set(key, answer);
        if (seq === flagsSeq) { flagsShown = key; paintFlags(answer, body.agent_type); }
    }, 120);
}

// The "Runs as" line (#15885, LA1a): Provider, Model, Thinking and Permission mode as four compact controls on one line (two at 390 px), the
// recap's place. Each one is a window on the form's own field (the fields stay the one place that sets anything): it shows that field's value, the
// Settings default until the person changes it, and a change in it is a change in the field (the field's own change handler runs), so the line
// can never say one thing and the launch another. A control whose field is hidden for this CLI (no Thinking, no Model for a terminal) is hidden.
const CONTROLS = [
    { key: 'provider', name: 'Provider', field: '.acf-agent-type', tag: 'select' },
    { key: 'model', name: 'Model', field: '.acf-model', tag: 'input' },
    { key: 'thinking', name: 'Thinking', field: '.acf-thinking', tag: 'select' },
    { key: 'mode', name: 'Permission mode', field: '.acf-permission-mode', tag: 'select' },
];
const lineEl = () => document.querySelector('#launch-recap .runs-as');

function buildLine() {
    const line = document.createElement('div');
    line.className = 'runs-as';
    line.setAttribute('role', 'group');
    line.setAttribute('aria-label', 'Runs as');
    const lead = document.createElement('span');
    lead.className = 'runs-as-lead';
    lead.textContent = 'Runs as';
    lead.setAttribute('aria-hidden', 'true');
    line.append(lead);
    for (const c of CONTROLS) {
        const label = document.createElement('label');
        label.className = `runs-as-ctl runs-as-${c.key}`;
        const name = Object.assign(document.createElement('span'), { className: 'runs-as-name', textContent: c.name });
        label.append(name);
        if (c.tag === 'select') label.append(Object.assign(document.createElement('select'), { className: `runs-as-field runs-as-${c.key}-field` }));
        else { // the model box offers the form's own names
            const box = Object.assign(document.createElement('input'), { type: 'text', className: 'runs-as-field runs-as-model-field', autocomplete: 'off', placeholder: 'Default model' });
            box.setAttribute('list', 'runs-as-models');
            label.append(box, Object.assign(document.createElement('datalist'), { id: 'runs-as-models' }));
        }
        label.querySelector('.runs-as-field').dataset.field = c.key;
        line.append(label);
    }
    line.addEventListener('change', forward);
    line.addEventListener('input', forward);
    return line;
}

/** A change in a control is a change in the form's field: the value is set there and the field's own listeners run. */
function forward(e) {
    const ctl = e.target.closest?.('.runs-as-field'), acf = container();
    if (!ctl || !acf) return;
    const c = CONTROLS.find(x => x.key === ctl.dataset.field), field = acf.querySelector(c.field);
    if (!field) return;
    if (c.key === 'model') {
        if (e.type !== 'input') return;
        field.value = ctl.value;
        acf.dataset.acfModelClassifying = 'false'; acf.dataset.acfModelDirty = 'true'; // the person's own value: a provider switch keeps it, as for a keystroke in the field itself
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        return;
    }
    if (e.type !== 'change') return;
    field.value = ctl.value;
    field.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Each control shows its field now: the options the field offers (a provider that is not installed is not one), its value, and whether it applies to this CLI. */
function syncLine(line, risky) {
    const acf = container();
    for (const c of CONTROLS) {
        const field = acf?.querySelector(c.field), label = line.querySelector(`.runs-as-${c.key}`), ctl = label.querySelector('.runs-as-field');
        const gone = !field || (c.key === 'thinking' && (field.closest('.acf-thinking-wrap')?.hidden || !field.options?.length)) || (c.key === 'model' && field.closest('.acf-model-wrap')?.style.display === 'none');
        label.hidden = !!gone;
        if (gone) continue;
        if (c.tag === 'select') {
            const shown = new Set([...document.querySelectorAll('#launch-agent-pick .provider-strip .provider-card-head')].map(h => h.dataset.type)); // the providers this computer has, as the strip shows them
            const opts = [...field.options].filter(o => !o.hidden && !o.disabled && (c.key !== 'provider' || !shown.size || shown.has(o.value) || o.value === field.value)), key = opts.map(o => o.value + '\u0001' + o.textContent).join('\u0002');
            if (ctl.dataset.opts !== key) { ctl.replaceChildren(...opts.map(o => Object.assign(document.createElement('option'), { value: o.value, textContent: o.textContent.trim() }))); ctl.dataset.opts = key; }
            if (ctl.value !== field.value) ctl.value = field.value;
        } else {
            const names = field.list, mine = label.querySelector('datalist'); // the form's own model names, copied into the line's list
            const key = names ? [...names.options].map(o => o.value).join('\u0001') : '';
            if (mine && mine.dataset.names !== key) { mine.dataset.names = key; mine.replaceChildren(...[...names.options].map(o => Object.assign(document.createElement('option'), { value: o.value }))); }
            if (document.activeElement !== ctl && ctl.value !== field.value) ctl.value = field.value;
        }
    }
    line.querySelector('.runs-as-mode')?.classList.toggle('runs-as-risky', !!risky); // a risky mode: amber, and the warning is under the line
}

function paintRecap() {
    const el = document.getElementById('launch-recap'), p = recapParts();
    if (!el || !p) return;
    let line = lineEl();
    if (!line) { line = buildLine(); el.prepend(line); }
    const allows = !p.mode || !p.modeNote ? '' : p.modeNote === PI_NO_PERMISSIONS.replace(/\.$/, '') ? PI_NO_PERMISSIONS : `${p.mode} mode allows: ${p.modeNote.charAt(0).toLowerCase() + p.modeNote.slice(1)}.`; // Pi has no modes to allow: its sentence stands alone
    const dash = p.modeRisky ? allows.indexOf(' \u2014 ') : -1; // a mode that is only safe somewhere (Bypass: "...isolated containers and VMs only") keeps its warning in two words: the whole sentence is its hover
    const risky = !!allows && p.modeRisky;
    syncLine(line, risky);
    if (el.dataset.recap === allows) return;
    el.dataset.recap = allows;
    el.querySelectorAll('.launch-recap-note').forEach(n => n.remove());
    if (allows) line.after(Object.assign(document.createElement('span'), { className: `launch-recap-note${risky ? ' launch-recap-warn-note' : ''}`, textContent: dash > 0 ? `\u26a0 ${allows.slice(dash + 3).charAt(0).toUpperCase()}${allows.slice(dash + 4)}` : allows, title: dash > 0 ? allows : '' }));
}


/** Follow the form once: any change in it, in the folder or the name, and the model default arriving after it was drawn. */
export function wireRecap() {
    const acf = container();
    if (!acf || acf.dataset.recapWired) return;
    acf.dataset.recapWired = '1';
    for (const t of ['input', 'change', 'acf-synced']) acf.addEventListener(t, () => syncRecap());
    for (const id of ['launch-dir', 'launch-agent-name-input']) { const e = document.getElementById(id); if (e) for (const t of ['input', 'change']) e.addEventListener(t, () => syncRecap()); }
}
