/* Open questions keep fenced commands separate and copyable; agent text stays text. */
import { importOnce } from './import_once.js';
import { markHidden } from './visible_marks.js';
export function openQuestion(node, raw, fallback) {
    const text = markHidden(raw, { strict: true });
    if (!/^```[^\n]*\n/m.test(text)) { node.textContent = fallback; return node; }
    const pieces = text.split(/^```[^\n]*\n([\s\S]*?)^```\s*$/m);
    node.replaceChildren();
    for (let i = 0; i < pieces.length; i++) {
        if (!(i % 2)) { node.append(document.createTextNode(pieces[i])); continue; }
        const block = document.createElement('span'), pre = document.createElement('pre'), code = document.createElement('code'), copy = document.createElement('button');
        block.className = 'inbox-command'; code.textContent = pieces[i]; pre.append(code);
        copy.type = 'button'; copy.className = 'btn btn-quiet btn-small'; copy.textContent = 'Copy command';
        copy.addEventListener('click', async e => { e.stopPropagation(); try { const { copyText } = await importOnce('./utils.js'); copy.textContent = await copyText(pieces[i]) ? 'Copied' : 'Copy failed'; } catch { copy.textContent = 'Copy failed'; } finally { copy.focus({ preventScroll: true }); } });
        block.append(pre, copy); node.append(block);
    }
    return node;
}
