/* The robot button (#15063, the Operator): "Copy for an agent" as a small icon, the same everywhere. It copies the object's own line and where in the docs the agent should read (agent_doc_map.js). */
import { copyText, showToast } from './utils.js';
import { loadStyles } from './lazy_styles.js';
import { importOnce } from './import_once.js';
const { agentCopyText } = await importOnce('./agent_doc_map.js'); // the table of where to read (a node test checks it)

await loadStyles('agent_copy_button.css');

export const AGENT_COPY_LABEL = 'Copy for an agent';

/** A robot icon button. `key`: a DOC_POINTERS name or { topic, section }; `subject`: the text (or a function giving it, read at the press) that names the object and its command. */
export function agentCopyButton(key, subject = '', opts = {}) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = `agent-copy${opts.className ? ' ' + opts.className : ''}`;
    b.title = AGENT_COPY_LABEL; b.setAttribute('aria-label', opts.label || AGENT_COPY_LABEL);
    const i = document.createElement('span'); i.className = 'material-icons'; i.setAttribute('aria-hidden', 'true'); i.textContent = 'smart_toy'; b.append(i);
    b.addEventListener('click', e => {
        e.stopPropagation();
        copyText(agentCopyText(key, typeof subject === 'function' ? subject() : subject)).then(ok => showToast(ok ? 'Copied: paste it to an agent' : 'Could not copy', !ok));
    });
    return b;
}

/** The robot inside `host` once: a screen that redraws calls this each time and gets one button (#15152). `at`: 'append' (the default), 'prepend' or 'after-title' (after the host's heading). */
export function agentCopyIn(host, key, subject, opts = {}) {
    if (!host || host.querySelector(':scope > .agent-copy')) return null;
    const b = agentCopyButton(key, subject, opts);
    if (opts.inside) host.querySelector(opts.inside)?.append(b); else if (opts.before) host.querySelector(opts.before)?.before(b); else if (opts.after) host.querySelector(opts.after)?.after(b); else if (opts.first) host.prepend(b); else host.append(b);
    return b;
}
