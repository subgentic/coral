/* New agent: "Trust this folder" (#19216, QA's SHOULD on #19176), the tick the team launch has (#11889). A folder Coral makes is trusted without it; an existing one only when the person ticks it, for that path.
 * Off by default, not shown through Coral Hub (the server ignores the tick there), and a tick names the folder it was made for: another folder goes back to off. launch_dialog.js sends trust_folder while
 * the tick is on and still names the folder in the field. Lazy, with the dialog: the start path does not carry it. */
import { isHub } from './server_base.js';
import { importOnce } from './import_once.js';

const { usesSuggestion } = await importOnce('./folder_suggestion.js');

const LABEL = 'Trust this folder: its settings and tools can run';

/** Put the tick under the Folder field of New agent (once). */
export function mountAgentTrust() {
    const dir = document.getElementById('launch-dir'), at = dir?.closest('.sv-row');
    if (!dir || !at || document.getElementById('launch-agent-trust-row')) return;
    const row = document.createElement('div'); row.id = 'launch-agent-trust-row'; row.className = 'launch-trust-tick'; row.hidden = true;
    const label = document.createElement('label'), box = document.createElement('input'), help = document.createElement('p');
    box.type = 'checkbox'; box.id = 'launch-agent-trust'; help.id = 'launch-agent-trust-help'; help.className = 'launch-trust-help';
    label.className = 'launch-trust-label'; label.append(box, document.createTextNode(LABEL));
    row.append(label, help); at.after(row);
    const sync = () => {
        const d = document.getElementById('launch-dir'), f = d?.value.trim() || '';
        if (box.checked && f !== box.dataset.trustFor) { box.checked = false; box.dataset.trustFor = ''; } // a tick is for one folder
        row.hidden = isHub() || !f || usesSuggestion(d);
        help.textContent = box.checked ? 'On, ' + f + " will be trusted where the CLI already has settings. Agents may still ask; answer together in Needs you. Untick to leave trust to the agent."
            : 'Coral will not trust ' + (f || 'this folder') + " unless this is on, so the agent's CLI asks about the folder when it starts.";
    };
    box.addEventListener('change', () => { box.dataset.trustFor = box.checked ? (document.getElementById('launch-dir')?.value.trim() || '') : ''; sync(); });
    dir.addEventListener('input', sync); dir.addEventListener('change', sync); sync();
}
