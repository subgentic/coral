import { parseCoralRef } from './coral_ref.js';
import { linkCoralSubjectRefsIn } from './coral_subject_refs.js';
/* The chat's bubble builder and file-reference links (#3837). Moved out of live_chat.js as it was; no behaviour change.
 * makeBubble(className, html) is how every feature builds a row: it returns a div of that class with the html in it, code blocks
 * labelled and copy buttons and file references wired. Pair it with appendContent (chat_content.js) to put the row in the chat. */
import { labelCodeBlocks } from './utils.js';
import { currentServer } from './server_base.js';
import { importOnce } from './import_once.js';

export function makeBubble(className, html) {
    const div = document.createElement("div");
    div.className = className;
    div.innerHTML = html;
    labelCodeBlocks(div);
    if (div.querySelector('.message-text pre')) importOnce('./chat_code_blocks.js').then(m => m.addCodeCopyButtons(div)).catch(() => {});
    linkifyRefs(div);
    return div;
}

// Each code block gets its own copy button. The block scrolls sideways, so
// the button sits on a wrapper around it rather than inside it.
// Swap a copy button's icon to a check for a moment after copying.
export function flashCopied(btn) {
    const icon = btn.querySelector(".material-icons");
    icon.textContent = "check";
    btn.classList.add("copied");
    clearTimeout(btn._copiedTimer);
    btn._copiedTimer = setTimeout(() => {
        icon.textContent = "content_copy";
        btn.classList.remove("copied");
    }, 1500);
}

// A path-looking inline code span: has a directory, a :line suffix, or a
// common source extension. Keeps `window.fetch` or `v1.2.3` from matching.
const FILE_REF_RE = /^(?:~?\.{0,2}\/)?(?:[\w@.+-]+\/)*[\w@.+-]+\.[A-Za-z][\w]{0,7}(?::\d+(?:[-:]\d+)?)?$/;
const FILE_REF_EXTS = new Set(["md", "js", "mjs", "cjs", "ts", "tsx", "jsx", "go", "py", "rb", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "zsh", "bash", "json", "yaml", "yml", "toml", "ini", "css", "scss", "html", "sql", "txt", "mod", "sum", "lock", "xml", "svg", "vue", "svelte"]);

function normalizeFileRef(raw) {
    if (!raw) return "";
    let s = String(raw).trim();
    if (/^file:\/\//i.test(s)) {
        s = s.replace(/^file:\/\/(?:localhost)?/i, "");
        if (!s.startsWith("/")) s = "/" + s;
    }
    // Convert markdown hash line anchor #L123, #L123-L145, #123 to :123
    s = s.replace(/#(?:L)?(\d+)(?:[-:]L?\d+)?$/i, ":$1");
    // Strip any remaining hash
    s = s.replace(/#.*$/, "");
    return s;
}

function looksLikeFileRef(text) {
    const s = normalizeFileRef(text);
    if (!s || !FILE_REF_RE.test(s) || /^https?:/i.test(s)) return false;
    const path = s.replace(/:\d+(?:[-:]\d+)?$/, "");
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    return path.includes("/") || path !== s || FILE_REF_EXTS.has(ext);
}

// A path in plain prose (not in backticks). Needs a directory so words like
// "e.g." or "README.md" in a sentence stay text; the lookbehind keeps it
// from matching inside a URL or a longer token.
const BARE_FILE_REF_RE = /(?<![\w\/:.@~-])(?:~?\.{0,2}\/)?(?:[\w@.+-]+\/)+[\w@.+-]*\w\.[A-Za-z]\w{0,7}(?::\d+(?:[-:]\d+)?)?(?![\w\/])/g;

// Web links open in a new tab; links to relative paths, path-looking inline
// code and bare paths in prose become file references (in the live Chat
// view, clicking one offers to open it in the Files panel).
export function linkifyRefs(root) {
    // A relative link in chat Markdown arrives with no href (utils.applyLinkPolicy, #3542): it
    // becomes a file reference when it looks like one, else plain text. It never navigates.
    for (const a of root.querySelectorAll("a[data-file-ref-raw]")) {
        const raw0 = a.getAttribute("data-file-ref-raw");
        a.removeAttribute("data-file-ref-raw");
        let raw = raw0;
        try { raw = decodeURIComponent(raw0); } catch {}
        if (/^file:/i.test(raw) || looksLikeFileRef(raw)) {
            a.dataset.fileRef = normalizeFileRef(raw);
            a.classList.add("chat-file-ref");
            a.setAttribute("role", "link");
            a.tabIndex = 0;
        } else {
            const span = document.createElement("span");
            span.className = "blocked-link";
            span.title = `Link not opened: ${raw0}`;
            span.textContent = a.textContent === raw0 ? raw0 : `${a.textContent} (${raw0})`;
            a.replaceWith(span);
        }
    }
    for (const a of root.querySelectorAll("a[href]")) {
        if (parseCoralRef(a.getAttribute("href"))?.kind && parseCoralRef(a.getAttribute("href")).kind !== 'artifact') continue;
        if (a.hasAttribute("data-route")) continue; // a dashboard page link the router accepted
        const href = a.getAttribute("href");
        const artifactHref = /^\/api\/artifacts\/([a-f0-9]{64})$/i.exec(href || '');
        if (/^coral:\/\/artifacts\/[a-f0-9]{64}$/i.test(href || '') || artifactHref) {
            a.dataset.fileRef = artifactHref ? `coral://artifacts/${artifactHref[1]}` : href;
            a.classList.add("chat-file-ref");
            continue;
        }
        if (/^(https?:|mailto:)/i.test(href)) {
            a.target = "_blank";
            a.rel = "noopener noreferrer";
        } else if (!href.startsWith("#")) {
            let raw = href;
            try { raw = decodeURIComponent(href); } catch {}
            if (/^file:/i.test(raw) || looksLikeFileRef(raw)) {
                a.dataset.fileRef = normalizeFileRef(raw);
                a.classList.add("chat-file-ref");
            }
        }
    }
    for (const code of root.querySelectorAll(":not(pre) > code")) {
        if (code.closest("a")) continue;
        const text = code.textContent.trim();
        if (/^coral:\/\/artifacts\/[a-f0-9]{64}$/i.test(text)) {
            code.dataset.fileRef = text;
            code.classList.add("chat-file-ref");
        } else if (looksLikeFileRef(text)) {
            code.dataset.fileRef = normalizeFileRef(text);
            code.classList.add("chat-file-ref");
        }
    }
    // Artifact URIs are often returned in fenced code blocks so they can be
    // copied reliably. Keep those exact values actionable as well.
    for (const code of root.querySelectorAll("pre code")) {
        const text = code.textContent.trim();
        if (/^coral:\/\/artifacts\/[a-f0-9]{64}$/i.test(text)) {
            code.dataset.fileRef = text;
            code.classList.add("chat-file-ref");
        }
    }
    // Plain-text artifact URIs (for example, a final response without
    // Markdown link syntax) should use the same interaction menu.
    const artifactWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: n => n.parentElement.closest('a, code, pre, [data-file-ref]')
            ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const artifactNodes = [];
    while (artifactWalker.nextNode()) {
        if (/coral:\/\/artifacts\/[a-f0-9]{64}/i.test(artifactWalker.currentNode.nodeValue)) artifactNodes.push(artifactWalker.currentNode);
    }
    for (const node of artifactNodes) {
        const frag = document.createDocumentFragment();
        let last = 0;
        for (const match of node.nodeValue.matchAll(/coral:\/\/artifacts\/[a-f0-9]{64}/gi)) {
            frag.append(node.nodeValue.slice(last, match.index));
            const span = document.createElement('span');
            span.className = 'chat-file-ref chat-file-ref-bare';
            span.dataset.fileRef = match[0];
            span.textContent = match[0];
            frag.append(span);
            last = match.index + match[0].length;
        }
        frag.append(node.nodeValue.slice(last));
        node.replaceWith(frag);
    }
    linkCoralSubjectRefsIn(root, { server: currentServer() });
    linkifyBarePaths(root);
}

function linkifyBarePaths(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => n.parentElement.closest("a, code, pre, .role-label, .pending-label")
            ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const nodes = [];
    while (walker.nextNode()) {
        if (/\/[^/\s]*\.\w/.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
    }
    for (const node of nodes) {
        const text = node.nodeValue;
        const frag = document.createDocumentFragment();
        let last = 0;
        for (const m of text.matchAll(BARE_FILE_REF_RE)) {
            if (!looksLikeFileRef(m[0])) continue;
            frag.append(text.slice(last, m.index));
            const span = document.createElement("span");
            span.className = "chat-file-ref chat-file-ref-bare";
            span.dataset.fileRef = normalizeFileRef(m[0]);
            span.textContent = m[0];
            frag.append(span);
            last = m.index + m[0].length;
        }
        if (last === 0) continue;
        frag.append(text.slice(last));
        node.replaceWith(frag);
    }
}

// File options are used only after a person clicks a live-chat reference.
document.addEventListener('click', e => {
    const el = e.target.closest?.('#live-history-messages [data-file-ref]');
    if (!el) return;
    e.preventDefault();
    importOnce('./chat_file_menu.js', 'file options').then(m => m.showFileRefMenu(el)).catch(() => {});
});

// Relative links in the history view have nowhere to go; keep them from
// navigating the dashboard away.
document.addEventListener("click", (e) => {
    const el = e.target.closest && e.target.closest("#history-messages a[data-file-ref]");
    if (el) e.preventDefault();
});
