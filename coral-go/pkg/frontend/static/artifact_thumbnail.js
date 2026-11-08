/* A reserved decorative footprint shared by artifact rows and version options.
 * Unsupported formats retain the established file-type artwork without reading bytes. */
import { fileIconHtml } from './file_icons.js';
export function artifactThumbnail(item = {}, { size = 16, url = '' } = {}) {
    const node = document.createElement('span');
    node.className = 'artifact-thumbnail';
    node.setAttribute('aria-hidden', 'true');
    node.style.setProperty('--artifact-thumbnail-size', `${size}px`);
    node.innerHTML = fileIconHtml(String(item.name || item.filename || ''), item.media_type || item.content_type);
    if (url && thumbnailPath(item)) watchThumbnail(node, url);
    return node;
}

/** Only stored raster images have a derivative; caller supplies the captured source URL. */
export function thumbnailPath(item = {}) {
    if (item.available === false || item.unverified || item.source === 'unverified') return '';
    const digest = /^coral:\/\/artifacts\/([a-f0-9]{64})$/.exec(String(item.uri || ''))?.[1] || (/^[a-f0-9]{64}$/.test(String(item.id || item.digest || '')) ? String(item.id || item.digest) : '');
    const type = String(item.media_type || item.content_type || '').split(';')[0].trim().toLowerCase();
    const raster = ['image/png', 'image/jpeg', 'image/gif'].includes(type) || (!type && /\.(png|jpe?g|gif)$/i.test(String(item.name || '')));
    return digest && raster ? `/api/artifacts/${digest}/thumbnail` : '';
}

// Observers are shared by all surfaces. Only two visible image reads run at once;
// removed rows lose their queued work and abort their in-flight request.
const pending = new Map(), queue = new Map(), running = new Map();
let observer, removals, active = 0;
function prune() {
    for (const [node] of pending) if (!node.isConnected) { observer?.unobserve(node); pending.delete(node); queue.delete(node); running.get(node)?.abort(); }
    if (!pending.size) { observer?.disconnect(); removals?.disconnect(); }
}
function pump() {
    prune();
    while (active < 2 && queue.size) {
        const [node, url] = queue.entries().next().value; queue.delete(node);
        if (!node.isConnected) continue;
        observer?.unobserve(node);
        const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 5000); running.set(node, abort); active++;
        (async () => {
            let objectURL;
            try {
                const response = await fetch(url, { signal: abort.signal, cache: 'no-store' });
                if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'image/png') return;
                const reader = response.body?.getReader(); if (!reader) return;
                const chunks = []; let size = 0;
                for (;;) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > 128 * 1024) { await reader.cancel(); return; } chunks.push(value); }
                if (!node.isConnected || abort.signal.aborted) return;
                const blob = new Blob(chunks, { type: 'image/png' });
                const header = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
                if (header.length < 24 || ![137,80,78,71,13,10,26,10].every((v,i)=>header[i]===v)) return;
                const dimensions = new DataView(header.buffer, header.byteOffset, header.byteLength);
                const width = dimensions.getUint32(16), height = dimensions.getUint32(20);
                if (!width || !height || width > 128 || height > 128) return;
                objectURL = URL.createObjectURL(blob);
                const img = new Image(); img.alt = ''; img.decoding = 'async'; img.src = objectURL;
                await Promise.race([img.decode(), new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('thumbnail timed out')), { once: true }))]);
                if (node.isConnected && !abort.signal.aborted) { img.className = 'artifact-thumbnail-image'; node.replaceChildren(img); }
            } catch { /* type icon remains for unavailable, denied, old-server and malformed results */ }
            finally {
                clearTimeout(timeout);
                if (objectURL) URL.revokeObjectURL(objectURL);
                pending.delete(node); running.delete(node); active--; pump();
            }
        })();
    }
}
function watchThumbnail(node, url) {
    if (typeof IntersectionObserver !== 'function') return;
    observer ||= new IntersectionObserver(entries => {
        for (const e of entries) {
            if (!pending.has(e.target) || running.has(e.target)) continue;
            if (e.isIntersecting) queue.set(e.target, pending.get(e.target)); else queue.delete(e.target);
        }
        pump();
    }, { rootMargin: '80px' });
    removals ||= new MutationObserver(prune);
    pending.set(node, url);
    // Connect after the caller inserts its new row, so pruning cannot drop it
    // while DataTable is still constructing the other cells synchronously.
    queueMicrotask(() => {
        if (!node.isConnected) { pending.delete(node); return; }
        observer.observe(node); removals.observe(document.body, { childList: true, subtree: true });
    });
}
