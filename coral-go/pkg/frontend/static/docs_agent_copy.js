/* The robot in the Docs viewer (#15063, the Operator): beside the document's title and every section heading, a button that copies the exact place being read (`Docs: coral-agent docs <topic>, section "<heading>"`),
 * so a person reading the docs can hand an agent the precise section. Loaded by docs.js after a document is drawn. */
import { importOnce } from './import_once.js';
import { isPhoneLayout } from './phone_layout.js';
const { agentCopyButton } = await importOnce('./agent_copy_button.js');

const clean = h => (h.firstChild && h.firstChild.nodeType === 3 ? h.textContent : h.textContent).replace(/\s*#\s*$/, '').replace(/\s*\(#\d+\)\s*$/, '').trim();

/** Wraps each heading of the drawn document with its robot (the title only where it is not the phone's way-back row). */
export function addDocRobots(content, topic) {
    const had = document.activeElement; // a heading that has the focus (the page opened at an answer) keeps it when its row is made
    for (const h of content.querySelectorAll('h1, h2, h3')) {
        if (h.parentElement?.classList.contains('docs-hrow') || (h.tagName === 'H1' && (isPhoneLayout() || h.parentElement !== content))) continue;
        const section = h.tagName === 'H1' ? '' : clean(h);
        const row = document.createElement('div'); row.className = 'docs-hrow';
        h.replaceWith(row); row.append(h, agentCopyButton({ topic, section }, '', { label: section ? `Copy for an agent: ${section}` : 'Copy for an agent: this document' }));
    }
    if (had && had !== document.activeElement && had.isConnected) had.focus({ preventScroll: true });
}
