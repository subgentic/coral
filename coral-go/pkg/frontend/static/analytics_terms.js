/* What the words of an Analytics table mean, behind an (i) beside the table's title (#10001, Beta tester #9953: "Cache reads", "Sent back" and "Median" were unexplained). One glossary line per word,
 * shown only for the words the table has; the text stays in the page, hidden until the (i) opens it (info_toggle.js, the same (i) as Settings). */
import { importOnce } from './import_once.js';
const { bindInfo } = await importOnce('./info_toggle.js');

const TERMS = {
    tokens: ['Tokens', 'The text an agent reads and writes; usage is counted in tokens.'],
    portion: ['Share', 'This agent\'s part of all the tokens in the range.'],
    commits: ['Commits', 'Commits that reached main in the range; a commit counts once, for the agent that wrote it.'],
    cache: ['Cache reads', 'Tokens served from the provider\'s prompt cache. They cost far less than fresh ones.'],
    tools: ['Tool calls', 'Times an agent used a tool: a command, a file edit, a search.'],
    done: ['Tasks done', 'Tasks the agent completed in the range.'],
    median: ['Median time', 'Half of the tasks took less than this, half took longer.'],
    sentBack: ['Sent back', 'Tasks a reviewer returned for changes.'],
};

let seq = 0;

/** Put an (i) after `title` (a heading element) that opens the meaning of `keys`' words under it. */
export function addTermsInfo(title, keys) {
    const id = `analytics-terms-${++seq}`;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'settings-info-btn'; btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', id); btn.setAttribute('aria-label', `About the words in ${title.textContent}`);
    const icon = document.createElement('span'); icon.className = 'material-icons'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = 'info'; btn.append(icon);
    const box = document.createElement('dl'); box.id = id; box.className = 'settings-info-text analytics-terms'; box.hidden = true;
    for (const k of keys) {
        const [word, meaning] = TERMS[k];
        const row = document.createElement('div'); const dt = document.createElement('dt'); dt.textContent = word; const dd = document.createElement('dd'); dd.textContent = meaning; row.append(dt, dd); box.append(row);
    }
    title.after(btn, box);
    bindInfo(title.parentElement);
}
