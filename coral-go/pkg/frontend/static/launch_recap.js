/* New Agent's recap line (#7391): above the footer from step 2 on, one read-only sentence of what Launch will do: "QA Engineer: Claude, /tmp/payments-app, default model, Auto mode". It is plain text read from the form's own
 * fields (the fields stay the one place that sets anything), so it can never say one thing and the launch another. */
import { modelName } from './model_labels.js';
import { importOnce } from './import_once.js';
import { loadStyles } from './lazy_styles.js';
import { serverFetch } from './server_base.js';
const { permissionDescription, PI_NO_PERMISSIONS } = await importOnce('./permission_flags.js'); // lazy like launch_dialog.js: a lazy module is loaded through importOnce (import_hygiene)

await loadStyles('launch_recap_flags.css'); // the flags line's rules: not at start

const container = () => document.getElementById('launch-agent-acf');
const TYPE = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity', antigravity: 'Antigravity', gemini: 'Antigravity', pi: 'Pi' };

/** What a permission mode allows for this CLI, in the words Settings and the Permissions tab use for it (Codex's Auto is its workspace sandbox with the network on; Antigravity's and Gemini's skip every prompt and check; Pi has no permissions at all): the footer says it, so 'Auto mode' is not left unexplained (Desktop tester, #10000). */
function modeNote(type, value) { return permissionDescription(type, value).replace(/\.$/, ''); }

/** The recap's parts: the person's name for the agent, then the provider, the folder, the model and the mode, each as words. */
function recapParts() {
    const acf = container();
    if (!acf) return null;
    const type = acf.querySelector('.acf-agent-type')?.value || 'claude';
    const model = (acf.querySelector('.acf-model')?.value || '').trim();
    const modeSel = acf.querySelector('.acf-permission-mode');
    return {
        name: (document.getElementById('launch-agent-name-input')?.value || '').trim(),
        provider: TYPE[type] || type,
        folder: (document.getElementById('launch-dir')?.value || '').trim() || 'no folder yet',
        model: model ? modelName(type, model) : 'default model',
        mode: modeSel ? (modeSel.options[modeSel.selectedIndex]?.textContent.trim() || '') : '',
        modeNote: modeSel ? modeNote(type, modeSel.value) : '',
    };
}

/** A long folder on a phone (under 600 px) is cut in the middle, its ends kept, so the summary above Launch stays two or three lines at 320 px (#11235); its whole path is the hover. */
const PHONE_PATH_MAX = 26;
const shortPath = p => (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 599px)').matches && p.length > PHONE_PATH_MAX) ? `${p.slice(0, 10)}\u2026${p.slice(-(PHONE_PATH_MAX - 11))}` : p;

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
    if (!answer) return;
    const line = document.createElement('span'); line.className = 'launch-recap-note launch-recap-flags';
    const text = answer.text || '';
    if (type === 'pi') line.textContent = 'Adds no permission flags: Pi has none.';
    else if (!text) line.textContent = `Adds no permission flags: ${TYPE[type] || type} starts in its own default.`;
    else { const code = document.createElement('code'); code.textContent = text; line.append('Adds ', code, ' to the command.'); }
    el.append(line);
    if (answer.note) { // why what is added is not what the pick stands for (#15735): a role's rule, kept Full access, or Codex's own settings; the server says it
        const why = document.createElement('span'); why.className = 'launch-recap-note launch-recap-flags launch-recap-why'; why.textContent = String(answer.note); el.append(why);
    }
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
        try {
            const server = (await importOnce('./launch_models.js'))._acfServer(container());
            const r = await serverFetch(server, '/api/launch/permission-args', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: key });
            if (!r.ok) return;
            const answer = await r.json();
            if (!Array.isArray(answer.args)) return;
            flagsCache.set(key, answer);
            if (seq === flagsSeq) { flagsShown = key; paintFlags(answer, body.agent_type); }
        } catch { /* no line: the recap above still says the mode */ }
    }, 120);
}

function paintRecap() {
    const el = document.getElementById('launch-recap'), p = recapParts();
    if (!el || !p) return;
    const folder = shortPath(p.folder), text = `${p.name ? p.name + ': ' : ''}${p.provider}, ${folder}, ${p.model}${p.mode ? ', ' + p.mode + ' mode' : ''}`;
    const note = !p.mode || !p.modeNote ? '' : p.modeNote === PI_NO_PERMISSIONS.replace(/\.$/, '') ? PI_NO_PERMISSIONS : `${p.mode} mode allows: ${p.modeNote.charAt(0).toLowerCase() + p.modeNote.slice(1)}.`; // Pi has no modes to allow: its sentence stands alone
    if (el.dataset.recap === text + note) return;
    el.dataset.recap = text + note;
    const b = s => { const e = document.createElement('b'); e.textContent = s; return e; };
    const dash = /isolated/i.test(note) ? note.indexOf(' \u2014 ') : -1; // a mode that is only safe somewhere (Bypass: "...isolated containers and VMs only") keeps its warning in two words: the whole sentence is its hover
    const line = note ? [Object.assign(document.createElement('span'), { className: 'launch-recap-note', textContent: dash > 0 ? `\u26a0 ${note.slice(dash + 3).charAt(0).toUpperCase()}${note.slice(dash + 4)}` : note, title: dash > 0 ? note : '' })] : [];
    flagsShown = ''; // the replaced nodes took the flags line with them: syncFlags draws it again
    el.replaceChildren(...(p.name ? [b(p.name), ': '] : []), b(p.provider), ', ', Object.assign(b(folder), { title: folder === p.folder ? '' : p.folder }), `, ${p.model}`, ...(p.mode ? [', ', b(p.mode), ' mode'] : []), ...line);
}

let phoneWidthWired = false;

/** Follow the form once: any change in it, in the folder or the name, and the model default arriving after it was drawn. */
export function wireRecap() {
    const acf = container();
    if (!acf || acf.dataset.recapWired) return;
    acf.dataset.recapWired = '1';
    if (!phoneWidthWired) { phoneWidthWired = true; window.matchMedia?.('(max-width: 599px)').addEventListener?.('change', () => syncRecap()); } // a rotation or a resized window: the folder is cut or whole again at once, not at the next change in the form (#11791); one listener for the page, however many dialogs open (#11794)
    for (const t of ['input', 'change', 'acf-synced']) acf.addEventListener(t, () => syncRecap());
    for (const id of ['launch-dir', 'launch-agent-name-input']) { const e = document.getElementById(id); if (e) for (const t of ['input', 'change']) e.addEventListener(t, () => syncRecap()); }
}
