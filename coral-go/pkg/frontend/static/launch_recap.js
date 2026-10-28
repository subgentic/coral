/* New Agent's recap line (#7391): above the footer from step 2 on, one read-only sentence of what Launch will do: "QA Engineer: Claude, /tmp/payments-app, default model, Auto mode". It is plain text read from the form's own
 * fields (the fields stay the one place that sets anything), so it can never say one thing and the launch another. */
import { modelName } from './model_labels.js';
import { importOnce } from './import_once.js';
const { permissionDescription, PI_NO_PERMISSIONS } = await importOnce('./permission_flags.js'); // lazy like launch_dialog.js: a lazy module is loaded through importOnce (import_hygiene)

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

/** Put the recap right for what the form holds now (the nodes are replaced only when the words changed). */
export function syncRecap() {
    const el = document.getElementById('launch-recap'), p = recapParts();
    if (!el || !p) return;
    const text = `${p.name ? p.name + ': ' : ''}${p.provider}, ${p.folder}, ${p.model}${p.mode ? ', ' + p.mode + ' mode' : ''}`;
    const note = !p.mode || !p.modeNote ? '' : p.modeNote === PI_NO_PERMISSIONS.replace(/\.$/, '') ? PI_NO_PERMISSIONS : `${p.mode} mode allows: ${p.modeNote.charAt(0).toLowerCase() + p.modeNote.slice(1)}.`; // Pi has no modes to allow: its sentence stands alone
    if (el.textContent === text + note) return;
    const b = s => { const e = document.createElement('b'); e.textContent = s; return e; };
    const line = note ? [Object.assign(document.createElement('span'), { className: 'launch-recap-note', textContent: note })] : [];
    el.replaceChildren(...(p.name ? [b(p.name), ': '] : []), b(p.provider), ', ', b(p.folder), `, ${p.model}`, ...(p.mode ? [', ', b(p.mode), ' mode'] : []), ...line);
}

/** Follow the form once: any change in it, in the folder or the name, and the model default arriving after it was drawn. */
export function wireRecap() {
    const acf = container();
    if (!acf || acf.dataset.recapWired) return;
    acf.dataset.recapWired = '1';
    for (const t of ['input', 'change', 'acf-synced']) acf.addEventListener(t, () => syncRecap());
    for (const id of ['launch-dir', 'launch-agent-name-input']) { const e = document.getElementById(id); if (e) for (const t of ['input', 'change']) e.addEventListener(t, () => syncRecap()); }
}
