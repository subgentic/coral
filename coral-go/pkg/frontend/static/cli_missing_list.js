/* The one message for a CLI that was found and not used (#12364): ONE short line ("Not used: ~/.local/bin/agy is inside Security Reviewer's working folder (~).", the agent's name opens its chat) and the steps behind a "Why?" fold.
 * The launch dialog's single-CLI banner and the first-run page use it. The list of missing providers that lived here moved to Settings (#15887). The server's words are read, never trusted as markup: every piece is set as text. */
import { el } from './dom_el.js';
import { importOnce } from './import_once.js';
const { refusedWords } = await importOnce('./cli_refused_words.js'); // what the server's note says, in pieces (a pure module a node test also reads)
const { agentLink } = await importOnce('./agent_link.js'); // the agent's name opens its chat, as everywhere (#12168)

const STEPS = {
    agent: agent => [`Archive ${agent ? agent : 'that agent'} (an asleep one counts too), or restart it in a project folder, then check again.`, 'Or install the CLI somewhere else.', 'Or set its path in Settings > CLI paths.'],
    other: () => ['Install the CLI somewhere else.', 'Or set its path in Settings > CLI paths.'],
};

/** The one message wherever a person meets a CLI that was found and not used (the list, and the launch dialog's single-CLI banner, #12364): [the short line, the Why? fold]. Every piece is text; the agent's name is the shared link. */
export function refusedBlock(note, { board = '' } = {}) {
    const w = refusedWords(note), line = el('p', 'provider-why-line sv-hint'), where = w.path || 'It';
    if (w.kind === 'agent') line.append(`Not used: ${where} is inside `, agentLink(w.agent, { board }), `'s working folder (${w.folder}).`);
    else if (w.kind === 'temp') line.append(`Not used: ${where} is in a temporary folder.`);
    else if (w.kind === 'data') line.append(`Not used: ${where} is in Coral's data folder.`);
    else line.append(`Not used: ${where} is in a folder a launch refuses.`);
    const det = el('details', 'provider-why'), sum = el('summary', null, 'Why?'); det.append(sum);
    const ol = el('ol', 'provider-steps'); for (const t of (STEPS[w.kind] || STEPS.other)(w.agent)) ol.append(el('li', null, t));
    det.append(el('p', 'sv-hint', 'A launch will not use a CLI inside a folder an agent works in, a temporary folder or Coral\'s data folder.'), ol);
    return [line, det];
}
