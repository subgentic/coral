/* A goal's words as the page shows them (#12724, direction A): the description is Markdown-lite (the New goal screen's toolbar writes bold, italic, headings, lists, checkboxes, code and links), drawn through the
 * dashboard's safe renderer (safe_markdown.js: built with the DOM, no HTML string, no image, links http, https and mailto with the host shown), then a coral://artifacts/<hex> reference in it becomes a link as
 * it did in plain text (#11416). If the renderer cannot load, the words are plain text with the same links: never markup. The New goal screen's Preview and the goal's page both call this one function. */
import { importOnce } from './import_once.js';
const { renderSafe } = await importOnce('./safe_markdown.js'); // lazy: its failure is retried
const { loadSafeMarkdown } = await importOnce('./vendor_loader.js');
const { linkArtifactRefsIn } = await importOnce('./artifact_refs.js');
const { keepBreaks } = await importOnce('./goal_guide.js'); // single line breaks stay breaks

/** @param {string} text @param {{ server?: string }} [opts] @returns {Promise<HTMLElement>} */
export async function renderGoalText(text, { server } = {}) {
    await loadSafeMarkdown().catch(() => { /* renderSafe's own fallback: plain text */ });
    const { node } = renderSafe(keepBreaks(text));
    node.classList.add('goal-md');
    return linkArtifactRefsIn(node, { server });
}
