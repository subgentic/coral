/* The Docs tab's Markdown renderer, lazy: the Docs page (docs.js) is the only caller, so its link and image rules are not in the start's bundle (#18435, moved out of markdown.js unchanged). */
import { DOMPURIFY_CONFIG, noTilde, sanitizeHtml } from './markdown.js';

// A Docs page may show its own screenshots (#5038): ![alt](docs-img/<name>.png) names a file in static/docs-img, which renderDocsMarkdown turns into this server's own
// versioned URL for it. That exact shape (a lower-case name, .png, no query or fragment, under this server's /static) is the one image source besides an artifact, data: or blob: that
// survives; it is a file embedded in Coral itself, never one an author names.
const DOC_IMAGE = /^docs-img\/([a-z0-9][a-z0-9-]*\.png)$/;

// The Docs tab (#3622 F4): Coral's bundled docs through the same sanitizer and link policy as
// everything else. A link from one doc to another ("auth.md", "board.md#tasks") becomes that doc's
// dashboard page (/docs/<name>), which the 'board' link policy keeps as a router link. Its own
// marked instance, so chat and board rendering keep their options. null when marked is missing.
const DOC_LINK = /^([A-Za-z0-9][A-Za-z0-9_-]*)\.md(?:#\S*)?$/;

let _docsMarked = null;

export function renderDocsMarkdown(md) {
    if (!_docsMarked && typeof marked !== 'undefined' && typeof marked.Marked === 'function') {
        _docsMarked = new marked.Marked(noTilde);
        _docsMarked.use({
            walkTokens(token) {
                if (token.type === 'image') {
                    const img = DOC_IMAGE.exec(token.href || '');
                    if (img) token.href = new URL(`./docs-img/${img[1]}`, import.meta.url).pathname; // inherits a versioned static prefix, as cm_util.js's stylesheet does
                    return;
                }
                if (token.type !== 'link') return;
                const m = DOC_LINK.exec(token.href || '');
                if (m) token.href = `/docs/${m[1]}`;
            },
        });
    }
    if (!_docsMarked) return null;
    return sanitizeHtml(_docsMarked.parse(String(md || '')), DOMPURIFY_CONFIG, { links: 'board', headings: 0 }); // a Docs page owns its h1: the outline is the page's own
}
