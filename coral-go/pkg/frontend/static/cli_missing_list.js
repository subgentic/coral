/* The agents this computer cannot use yet, as one list (#12364, the operator: "we need to clean this up"). One row per CLI with three aligned columns: its name, a short status chip (Not installed, Not used) and
 * one action (Install X, or Choose a path when it was found but a launch refuses it). A CLI that was found and not used says why in ONE short line ("Not used: ~/.local/bin/agy is inside Security Reviewer's working
 * folder (~)", the agent's name opens its chat) and the steps behind a "Why?" fold. The server's words are read, never trusted as markup: every piece is set as text. */
import { el } from './dom_el.js';
import { importOnce } from './import_once.js';
const { agentLink } = await importOnce('./agent_link.js'); // the agent's name opens its chat, as everywhere (#12168)

/** What the server's refusal says, in pieces: { path, kind: 'agent'|'temp'|'data'|'other', agent, folder }. The note is "Found but not used: <path> is in an agent's working folder: the agent "<name>" works in <folder>. Archive ..., so a launch refuses it. ...". */
export function refusedWords(note) {
    const text = String(note || ''), out = { path: '', kind: 'other', agent: '', folder: '' };
    const p = /^Found but not used: (\S+) is /.exec(text); if (p) out.path = p[1];
    const a = /the agent ("(?:[^"\\]|\\.)*") works in (\S+?)\. /.exec(text);
    if (a) { try { out.agent = JSON.parse(a[1]); } catch { out.agent = a[1].slice(1, -1); } out.folder = a[2]; out.kind = 'agent'; }
    else if (/in a temporary folder/.test(text)) out.kind = 'temp';
    else if (/in Coral's data folder/.test(text)) out.kind = 'data';
    return out;
}

const STEPS = {
    agent: agent => [`Archive ${agent ? agent : 'that agent'} (an asleep one counts too), or restart it in a project folder, then check again.`, 'Or install the CLI somewhere else.', 'Or set its path in Settings > CLI paths.'],
    other: () => ['Install the CLI somewhere else.', 'Or set its path in Settings > CLI paths.'],
};

/** The list. rows: [{ type, label, refused (the server's note, '' when it is simply not installed), url }]; chooseHandler(type) opens the path field; idPrefix makes the ids unique. Returns the section element. */
export function buildMissingList({ rows, idPrefix, board = '', onChoosePath, installOf }) {
    const sec = el('div', 'provider-missing'); sec.setAttribute('role', 'group');
    const h = el('h5', 'group-head provider-missing-title', 'Not installed or not used'); h.id = `${idPrefix}-missing`; sec.setAttribute('aria-labelledby', h.id);
    const list = el('ul', 'provider-list'); list.setAttribute('role', 'list');
    sec.append(h, list);
    for (const r of rows) {
        const li = el('li', 'provider-card provider-entry is-missing' + (r.refused ? ' is-refused' : '')); li.dataset.type = r.type;
        const name = el('span', 'provider-name', r.label), chip = el('span', 'chip provider-chip', r.refused ? 'Not used' : 'Not installed');
        const act = el('span', 'provider-action');
        if (r.refused) {
            if (onChoosePath) { const b = el('button', 'btn btn-small provider-choose', 'Choose a path'); b.type = 'button'; b.setAttribute('aria-label', `Choose a path for ${r.label}`); b.addEventListener('click', () => onChoosePath(r.type)); act.append(b); }
        } else {
            const a = el('a', 'provider-install', `Install ${r.label}`); a.href = r.url || '#'; a.target = '_blank'; a.rel = 'noopener noreferrer'; act.append(a);
        }
        const mark = el('span', 'provider-mark', r.mark || ''); mark.setAttribute('aria-hidden', 'true'); // the card's badge letter, kept for the suites and hidden here (the name is the label)
        li.append(mark, name, chip, act);
        if (r.refused) {
            const w = refusedWords(r.refused), line = el('p', 'provider-why-line sv-hint');
            const where = w.path || 'It';
            if (w.kind === 'agent') { line.append(`Not used: ${where} is inside `, agentLink(w.agent, { board }), `'s working folder (${w.folder}).`); }
            else if (w.kind === 'temp') line.append(`Not used: ${where} is in a temporary folder.`);
            else if (w.kind === 'data') line.append(`Not used: ${where} is in Coral's data folder.`);
            else line.append(`Not used: ${where} is in a folder a launch refuses.`);
            const det = el('details', 'provider-why'), sum = el('summary', null, 'Why?'); det.append(sum);
            const ol = el('ol', 'provider-steps'); for (const s of (STEPS[w.kind] || STEPS.other)(w.agent)) ol.append(el('li', null, s));
            det.append(el('p', 'sv-hint', 'A launch will not use a CLI inside a folder an agent works in, a temporary folder or Coral\'s data folder.'), ol);
            li.append(line, det);
        }
        list.append(li);
    }
    return sec;
}
