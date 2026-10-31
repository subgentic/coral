import { isCloud } from './server_base.js';

/* Shared CodeMirror 6 helpers — used by the file preview pane and the inline
 * diffs in the Files tab, so both render code the same way. */

// unifiedMergeView defaults to scanLimit 500 — far below the differ's own
// default — which makes it stop refining on any file with edits spread through
// it and return the whole file as one chunk. Scan far enough to diff real
// files properly, bounded by time so a pathological one degrades rather than
// hanging the tab.
export const DIFF_CONFIG = { scanLimit: 20000, timeout: 1500 };

/** Get the CodeMirror module (window.CoralCM), or null when it is not loaded yet.
 *  It loads on demand (vendor_loader.loadCodeMirror, #3083): callers await that first. */
export function getCm() {
    return window.CoralCM || null;
}

/** Resolve a language extension by name, or null when unsupported. */
export function getLangExtension(cm, langName) {
    const loaders = {
        javascript: () => cm.javascript(),
        typescript: () => cm.javascript({ typescript: true }),
        jsx:        () => cm.javascript({ jsx: true }),
        tsx:        () => cm.javascript({ jsx: true, typescript: true }),
        python: () => cm.python(), html: () => cm.html(), css: () => cm.css(),
        json: () => cm.json(), markdown: () => cm.markdown(), sql: () => cm.sql(),
        rust: () => cm.rust(), cpp: () => cm.cpp(), c: () => cm.cpp(),
        java: () => cm.java(), go: () => cm.go(), xml: () => cm.xml(), yaml: () => cm.yaml(),
    };
    const loader = loaders[langName];
    if (!loader) return null;
    try { return loader(); } catch { return null; }
}

/** Map a file path to a language name for highlighting. */
export function getLangFromPath(fp) {
    const ext = (fp.match(/\.(\w+)$/) || [])[1] || '';
    const map = {
        js: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
        py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
        sh: 'bash', zsh: 'bash', bash: 'bash', yml: 'yaml', yaml: 'yaml',
        json: 'json', toml: 'toml', css: 'css', scss: 'scss',
        html: 'html', xml: 'xml', sql: 'sql', c: 'c', cpp: 'cpp',
        h: 'c', hpp: 'cpp', cs: 'csharp', swift: 'swift', kt: 'kotlin',
        md: 'markdown',
    };
    return map[ext.toLowerCase()] || ext.toLowerCase() || 'plaintext';
}

/** The element an editor mounts into. CodeMirror writes its theme into <style> elements, which the hub's CSP
 *  (style-src 'self') blocks; inside a shadow root it adopts a constructable stylesheet instead, which the CSP does
 *  not govern. So in cloud mode the editor lives in a shadow root and the page rules that style it (the same ones
 *  agentic.css/output.css hold for local mode) come from a stylesheet loaded from /static: no inline style anywhere. */
export function cmHost(body) {
    body.replaceChildren();
    const host = document.createElement('div');
    host.className = 'inline-preview-cm preview-pane-cm';
    body.appendChild(host);
    if (!isCloud() || !host.attachShadow) return host;
    const root = host.attachShadow({ mode: 'open' });
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('./css/cm_shadow.css', import.meta.url).href; // inherits a versioned static prefix
    const mount = document.createElement('div');
    mount.className = 'cm-shadow-mount';
    root.append(link, mount);
    return mount;
}

/** The editor's colours follow the page's theme (#7654): CodeMirror's own light look in the light theme, One Dark only in the dark one. Taken when the editor is made, as each file or tab opens it afresh. */
export function cmTheme(cm) {
    return document.documentElement.getAttribute('data-theme') === 'light' ? [] : [cm.oneDark];
}
