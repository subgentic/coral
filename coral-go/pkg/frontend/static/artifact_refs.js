/* A Coral artifact named in plain text becomes a link (#11416). Team-written text (a task's description and result, a goal's outcome, a comment) holds coral://artifacts/<64 hex> as the words an agent
 * wrote; this is the one place that says what such a reference is and how it is drawn. The rule: "coral://artifacts/" and exactly 64 hex digits (shown and linked in lower case), not glued to a longer word on either side (so
 * a ')' or ':' or '.' after it is left as text, and 65 digits are no reference). The anchor is built here from the validated hex only (never from the text around it), the words around it are text, and a
 * plain click opens the artifact in the in-app viewer; a modified or middle click keeps the link's new tab (the artifact as the server serves it). */
import { artifactLabel, learnArtifactNames } from './artifact_names.js';
import { serverUrl, artifactPath } from './server_base.js';
import { importOnce } from './import_once.js';
import { escapeHtml, escapeAttr } from './html_escape.js';

export const ARTIFACT_REF = /(^|[^A-Za-z0-9/])coral:\/\/artifacts\/([a-f0-9]{64})(?![A-Za-z0-9])/gi; // upper-case hex is the same id (the board has always read it so); the hex used is lower-cased

/** The text as parts: { text } for words and { hex } for a reference, in order. */
export function splitArtifactRefs(text) {
    const s = String(text == null ? '' : text), parts = [];
    let at = 0, m;
    ARTIFACT_REF.lastIndex = 0;
    while ((m = ARTIFACT_REF.exec(s))) {
        const start = m.index + m[1].length;
        if (start > at) parts.push({ text: s.slice(at, start) });
        parts.push({ hex: m[2].toLowerCase() });
        at = start + 'coral://artifacts/'.length + 64;
    }
    if (at < s.length) parts.push({ text: s.slice(at) });
    return parts;
}

/** One link: its label is the stored name once known, else "artifact 81b837f8"; the full reference is the tooltip. Text only. */
function linkFor(hex, server) {
    const a = document.createElement('a');
    a.setAttribute('href', serverUrl(artifactPath(hex), server));
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = 'mb-artifact-ref';
    a.dataset.artifact = hex;
    if (server) a.dataset.server = server;
    a.textContent = artifactLabel(hex);
    a.title = `coral://artifacts/${hex}`;
    return a;
}

/** The text as nodes: the words as text nodes, each reference a link. Nothing in it is HTML. */
export function linkedText(text, { server } = {}) {
    const frag = document.createDocumentFragment(), seen = new Set();
    for (const p of splitArtifactRefs(text)) {
        if (p.hex) { frag.append(linkFor(p.hex, server)); seen.add(p.hex); } else frag.append(document.createTextNode(p.text));
    }
    if (seen.size) learnArtifactNames(seen);
    return frag;
}

/** Links the references in text already on the page (a Markdown render, a pre): every text node under `root` outside a link, code or script is split into words and links. A code block under the root is left alone; a root that is itself a pre is not. */
export function linkArtifactRefsIn(root, { server } = {}) {
    if (!root) return root;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.nodeValue.includes('coral://artifacts/')) continue;
        const up = n.parentElement && n.parentElement.closest('a, code, kbd, samp, script, style, pre');
        if (up && up !== root && root.contains(up)) continue; // inside a link or code under the root
        if (up === root && !root.matches('pre')) continue; // the root is itself a link or code (a pre of plain words is fine)
        nodes.push(n);
    }
    for (const n of nodes) {
        const parts = splitArtifactRefs(n.nodeValue);
        if (!parts.some(p => p.hex)) continue;
        const frag = linkedText(n.nodeValue, { server });
        n.replaceWith(frag);
    }
    return root;
}

/** The text as HTML for a surface that builds strings: the words escaped, each reference an anchor the delegated click below opens. */
export function linkedHtml(text) {
    const seen = new Set();
    const html = splitArtifactRefs(text).map(p => {
        if (!p.hex) return escapeHtml(p.text);
        seen.add(p.hex);
        return `<a href="${escapeAttr(serverUrl(artifactPath(p.hex)))}" target="_blank" rel="noopener noreferrer" class="mb-artifact-ref" data-artifact="${escapeAttr(p.hex)}" title="${escapeAttr(`coral://artifacts/${p.hex}`)}">${escapeHtml(artifactLabel(p.hex))}</a>`;
    }).join('');
    if (seen.size) learnArtifactNames(seen);
    return html;
}

// One listener for every such link, wherever it is drawn (and drawn again): a plain left click opens the viewer.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function' && !globalThis.__artifactRefClick) {
    globalThis.__artifactRefClick = true;
    document.addEventListener('click', e => {
        const a = e.target && e.target.closest && e.target.closest('a.mb-artifact-ref[data-artifact]');
        if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const hex = a.dataset.artifact;
        if (!/^[a-f0-9]{64}$/.test(hex || '')) return;
        e.preventDefault();
        const server = a.dataset.server || undefined;
        importOnce('./artifact_viewer.js').then(m => m.openArtifactViewer(hex, { server, filename: '' }), () => globalThis.open(serverUrl(artifactPath(hex), server), '_blank', 'noopener,noreferrer'));
    });
}
