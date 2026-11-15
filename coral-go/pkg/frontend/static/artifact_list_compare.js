/* Compare from the version list, including uploads grouped without a recorded series (#17522). Lazy only. */
import { importOnce } from './import_once.js';
import { serverUrl, artifactPath } from './server_base.js';
import { renderMarkdownStrict } from './utils.js';
import { markHidden } from './visible_marks.js';
import { lockFrame, sandboxedDoc } from './sandbox_frame.js';
const { diffLines } = await importOnce('./artifact_versions.js');
const { renderArtifact } = await importOnce('./artifact_preview.js');
const LIMIT = 2 * 1024 * 1024;
const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

export async function showComparison(dialog, opts, before, after) {
    const controller = new AbortController(), signal = controller.signal;
    let disposed = false, mode = 0;
    const stale = () => disposed || !dialog.isConnected || !dialog.open;
    const cleanup = () => { disposed = true; controller.abort(); };
    dialog.addEventListener('close', cleanup, { once: true });
    const source = async v => {
        const r = await fetch(serverUrl(artifactPath(v.hex), opts.server), { signal });
        if (!r.ok) throw new Error(`Could not read v${v.n} (HTTP ${r.status}).`);
        const type = (r.headers.get('content-type') || '').split(';')[0];
        if (!/^(text\/|application\/(json|xml|yaml|x-yaml|toml)|application\/.*\+(json|xml))/i.test(type)) return { text: null, type };
        if (Number(r.headers.get('content-length')) > LIMIT) throw new Error('This file is too large to compare as text.');
        const reader = r.body?.getReader();
        if (!reader) { const text = await r.text(); if (new TextEncoder().encode(text).length > LIMIT) throw new Error('This file is too large to compare as text.'); return { text, type }; }
        const decoder = new TextDecoder(); let text = '', size = 0;
        try {
            for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > LIMIT) throw new Error('This file is too large to compare as text.'); text += decoder.decode(value, { stream: true }); }
            return { text: text + decoder.decode(), type };
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    };
    let a, b;
    try { [a, b] = await Promise.all([source(before), source(after)]); }
    catch (e) { cleanup(); throw e; }
    if (stale()) { cleanup(); return; }
    const original = [...dialog.childNodes], section = node('section', 'version-compare');
    const title = node('h2', '', `Compare v${before.n} and v${after.n}: ${markHidden(String(opts.name || ''), { strict: true })}`); title.id = 'version-compare-title'; title.tabIndex = -1;
    const toolbar = node('div', 'version-compare-tools'), body = node('div', 'version-compare-body');
    const status = node('p', '', ''); status.setAttribute('role', 'status');
    const textButton = node('button', 'btn', 'Source changes'), renderButton = node('button', 'btn', 'Rendered side by side'), back = node('button', 'btn', 'Back to versions');
    for (const el of [textButton, renderButton, back]) el.type = 'button';
    const drawSource = () => {
        mode++; body.replaceChildren(); textButton.setAttribute('aria-pressed', 'true'); renderButton.setAttribute('aria-pressed', 'false');
        if (a.text === null || b.text === null) { body.append(node('p', '', 'Source changes are available for text files. Use rendered side by side for these versions.')); return; }
        const lines = diffLines(a.text, b.text);
        if (!lines) { body.append(node('p', '', 'These versions are too long to compare line by line.')); return; }
        const pre = node('pre', 'version-compare-source'); pre.tabIndex = 0; pre.setAttribute('aria-label', 'Source changes');
        for (const l of lines) { const line = node(l.t === 'add' ? 'ins' : l.t === 'del' ? 'del' : 'span', '', `${l.t === 'add' ? '+ ' : l.t === 'del' ? '- ' : '  '}${l.text}\n`); pre.append(line); }
        body.append(pre);
    };
    const drawRendered = async () => {
        const token = ++mode; body.replaceChildren(); textButton.setAttribute('aria-pressed', 'false'); renderButton.setAttribute('aria-pressed', 'true');
        const grid = node('div', 'version-compare-panes'); body.append(grid);
        await Promise.all([[before, a], [after, b]].map(async ([v, data]) => {
            const col = node('section', 'version-compare-pane'), heading = node('h3', '', `v${v.n}`), preview = node('div', 'version-compare-preview');
            col.append(heading, preview); grid.append(col);
            if (data.text !== null && (/html/i.test(data.type) || /\.x?html?$/i.test(opts.name || ''))) {
                const frame = node('iframe'); frame.setAttribute('aria-label', `Rendered v${v.n}`); lockFrame(frame); frame.srcdoc = sandboxedDoc(data.text); preview.append(frame); return;
            }
            await renderArtifact(preview, `coral://artifacts/${v.hex}`, { server: opts.server, board: opts.board, filename: opts.name, mediaType: data.type }, { signal, isStale: () => stale() || token !== mode, renderContent: (el, text, path) => { if (/\.(md|markdown|mdown)$/i.test(path || '')) { const prose = node('div', 'prose'); prose.innerHTML = renderMarkdownStrict(text); el.replaceChildren(prose); } else el.replaceChildren(node('pre', '', text)); }, setMeta() {}, openEntry() {} });
        }));
    };
    textButton.addEventListener('click', drawSource);
    renderButton.addEventListener('click', () => drawRendered().catch(e => { if (!stale()) status.textContent = e.message || 'Could not render these versions.'; }));
    back.addEventListener('click', () => { cleanup(); dialog.replaceChildren(...original); dialog.setAttribute('aria-labelledby', 'version-list-title'); dialog.querySelector('.version-list-compare')?.focus(); });
    toolbar.append(textButton, renderButton, back); section.append(title, toolbar, status, body);
    dialog.replaceChildren(section); dialog.setAttribute('aria-labelledby', title.id); drawSource(); title.focus();
}
