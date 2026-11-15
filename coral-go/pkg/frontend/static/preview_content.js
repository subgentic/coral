/* Render preview text, Markdown, and sandboxed HTML without owning tabs. */
import { escapeHtml, DOMPURIFY_CONFIG, sanitizeHtml, keepFragmentsInside } from './utils.js';
import { getLangFromPath } from './cm_util.js';
import { loadHighlight } from './vendor_loader.js';


export function _fileName(filepath) {
    const i = filepath.lastIndexOf('/');
    return i === -1 ? filepath : filepath.substring(i + 1);
}

/** Rendered HTML (sandboxed), formatted Markdown, or highlighted source. */
export function _renderContentView(body, content, filepath, line, interpretHtml) {
    if (interpretHtml && /\.html?$/i.test(filepath)) {
        _renderSandboxedPreview(body, content, filepath);
        return;
    }

    const lang = getLangFromPath(filepath);

    if (lang === 'markdown' && typeof marked !== 'undefined') {
        const { facts, rest } = splitMarkdownFrontMatter(content);
        const html = marked.parse(rest);
        // A workspace file can be agent-written: its links follow the file policy (#3542).
        const safe = sanitizeHtml(html, DOMPURIFY_CONFIG, { links: 'file', headings: 2 });
        body.innerHTML = `<div class="prose preview-pane-markdown">${safe}</div>`;
        if (facts.length) body.firstElementChild.prepend(_frontMatterBlock(facts)); // the front matter as a small key/value header, never run together as one paragraph (#16651)
        keepFragmentsInside(body);
        if (line > 0) _scrollToLine(body, content, line);
        return;
    }

    body.innerHTML = `<pre class="preview-pane-code"><code class="language-${lang}">${escapeHtml(content)}</code></pre>`;
    // Plain first; coloured once highlight.js has loaded (plain if it cannot).
    const block = body.querySelector('pre code');
    if (block) loadHighlight().then(h => { if (block.isConnected) h.highlightElement(block); }, () => {});
    if (line > 0) _scrollToLine(body, content, line);
}

/** A leading `---` block of `key: value` lines (a skill's name, description, metadata) split from the Markdown after it: { facts: [[key, value]], rest }. Indented lines continue the key above; a block that is not closed within 40 lines, or has no key, is not front matter. */
export function splitMarkdownFrontMatter(text) {
    const s = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    const lines = s.split(/\r?\n/);
    if (lines[0].trim() !== '---') return { facts: [], rest: s };
    let end = -1;
    for (let i = 1; i < lines.length && i <= 40; i++) if (lines[i].trim() === '---') { end = i; break; }
    if (end < 0) return { facts: [], rest: s };
    const facts = [];
    for (const line of lines.slice(1, end)) {
        const m = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(line);
        if (m) facts.push([m[1], m[2].trim().replace(/^(["'])(.*)\1$/, '$2')]);
        else if (facts.length && line.trim()) { const last = facts[facts.length - 1]; last[1] = `${last[1]} ${line.trim()}`.trim(); }
    }
    if (!facts.length) return { facts: [], rest: s };
    return { facts, rest: lines.slice(end + 1).join('\n').replace(/^\s*\n/, '') };
}

function _frontMatterBlock(facts) {
    const dl = document.createElement('dl'); dl.className = 'preview-front-matter';
    for (const [k, v] of facts) { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); }
    return dl;
}

function _renderSandboxedPreview(body, content, filepath) {
    const frame = document.createElement('iframe');
    frame.className = 'preview-pane-iframe';
    frame.setAttribute('aria-label', `Preview of ${_fileName(filepath)}`); // the frame's name for a screen reader; a title would show as a tooltip over the content (a ghost tooltip)
    frame.setAttribute('sandbox', '');
    frame.referrerPolicy = 'no-referrer';
    frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'">${content}`;
    body.replaceChildren(frame);
}

function _scrollToLine(container, content, line) {
    if (!line || line <= 1) return;
    requestAnimationFrame(() => {
        const total = content.split('\n').length;
        if (total <= 1) return;
        const pre = container.querySelector('pre.preview-pane-code');
        if (pre) {
            const approx = pre.scrollHeight / total;
            container.scrollTop = Math.max(0, (line - 1) * approx - container.clientHeight / 3);
        } else {
            const ratio = (line - 1) / total;
            container.scrollTop = Math.max(0, ratio * container.scrollHeight - container.clientHeight / 3);
        }
    });
}
