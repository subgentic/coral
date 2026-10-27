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
        const html = marked.parse(content);
        // A workspace file can be agent-written: its links follow the file policy (#3542).
        const safe = sanitizeHtml(html, DOMPURIFY_CONFIG, { links: 'file' });
        body.innerHTML = `<div class="prose preview-pane-markdown">${safe}</div>`;
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

function _renderSandboxedPreview(body, content, filepath) {
    const frame = document.createElement('iframe');
    frame.className = 'preview-pane-iframe';
    frame.title = `Preview of ${_fileName(filepath)}`;
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
