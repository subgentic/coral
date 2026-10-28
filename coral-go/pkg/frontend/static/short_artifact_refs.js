/* Shortened artifact links in messages already written (#9841). Coral now makes a short ref (coral://artifacts/b801aafb…f5f) whole when it stores a post, but older messages
 * still carry them. Here a short ref in a board message's text (not in a link, code or a code block) is asked of the server, which answers the one artifact the person may read that it
 * means; it becomes the same link a full reference is (the board's artifact pass then binds it). One that matches none or several stays the text it was.
 * Only this computer's messages are asked: another Coral's artifacts are not ours to look up. */
import { serverUrl } from './server_base.js';

// 8 to 63 hex digits after the scheme, then optionally an ellipsis (… or ...) and the end of the id; the same shape the server reads.
const SHORT_REF = /(^|[^A-Za-z0-9/])coral:\/\/artifacts\/([a-f0-9]{8,63})(?:(?:…|\.\.\.)([a-f0-9]{1,63}))?(?![A-Za-z0-9])/g;
// The way people write them too: the word artifact or shot and 8 to 16 hex digits ("shot 8d016dd8"). The server never expands these in a post (bare hex is too easily something else); here one is
// a link only when the server says exactly one artifact this person may read begins so, and its text stays what was written.
const WORDED_REF = /(^|[^A-Za-z0-9/])(?:artifact|shot)\s+([a-f0-9]{8,16})(?![A-Za-z0-9])/gi;
const MAX_PER_ASK = 20; // the route's limit

/** The short refs in a text: [{ start, end, ref, worded }] in order (ref is what the route is asked: the prefix, and … and the end when there is one; worded: the id after the word artifact or shot,
 *  start and end covering the digits only). */
export function findShortRefs(text) {
    const out = [];
    SHORT_REF.lastIndex = 0;
    let m;
    while ((m = SHORT_REF.exec(text))) {
        const start = m.index + m[1].length;
        out.push({ start, end: m.index + m[0].length, ref: m[2] + (m[3] ? '…' + m[3] : ''), worded: false });
    }
    WORDED_REF.lastIndex = 0;
    while ((m = WORDED_REF.exec(text))) {
        const end = m.index + m[0].length;
        out.push({ start: end - m[2].length, end, ref: m[2].toLowerCase(), worded: true });
    }
    return out.sort((a, b) => a.start - b.start);
}

const answers = new Map(); // ref -> the full id, or '' when the server found none or several: a message is drawn again and again
const asking = new Map(); // ref -> the promise of the ask in flight

async function ask(refs, server) {
    const todo = [...new Set(refs)].filter(r => !answers.has(r));
    for (let i = 0; i < todo.length; i += MAX_PER_ASK) {
        const chunk = todo.slice(i, i + MAX_PER_ASK);
        const url = serverUrl('/api/artifacts/resolve?' + chunk.map(r => 'link=' + encodeURIComponent(r)).join('&'), server);
        let data = null;
        try { const r = await fetch(url); data = r.ok ? await r.json() : null; } catch { data = null; }
        if (!data || !Array.isArray(data.refs)) continue; // not answered (offline, refused): asked again on the next draw
        for (const row of data.refs) answers.set(String(row.ref), row.id && /^[a-f0-9]{64}$/.test(row.id) ? row.id : '');
    }
}

function textNodesWithShortRefs(root) {
    const nodes = [];
    for (const body of root.querySelectorAll('.mb-message-body')) {
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!/coral:\/\/artifacts\/|artifact\s|shot\s/i.test(n.nodeValue)) continue;
            if (n.parentElement && n.parentElement.closest('code, pre, a, kbd, samp, script, style')) continue;
            if (findShortRefs(n.nodeValue).length) nodes.push(n);
        }
    }
    return nodes;
}

/** Turns the short refs under root into links where the server resolves them; resolves to whether anything changed. `after` runs on root when it did (the artifact pass that binds the links). */
export async function upgradeShortArtifactRefs(root, server, after) {
    if (!root || typeof document === 'undefined' || (server && server !== 'local' && server !== '')) return false;
    const nodes = textNodesWithShortRefs(root);
    if (!nodes.length) return false;
    const refs = nodes.flatMap(n => findShortRefs(n.nodeValue).map(f => f.ref));
    let pending = asking.get(refs.join('|'));
    if (!pending) {
        pending = ask(refs, server).finally(() => asking.delete(refs.join('|')));
        asking.set(refs.join('|'), pending);
    }
    await pending;
    let changed = false;
    for (const n of nodes) {
        if (!n.isConnected) continue; // the message was drawn again while the answer was on its way: that draw asks for itself
        const text = n.nodeValue;
        const frag = document.createDocumentFragment();
        let at = 0;
        for (const f of findShortRefs(text)) {
            const id = answers.get(f.ref);
            if (!id) continue;
            if (f.start > at) frag.append(text.slice(at, f.start));
            const a = document.createElement('a');
            a.setAttribute('href', `coral://artifacts/${id}`);
            a.setAttribute('rel', 'noopener noreferrer');
            a.className = 'mb-artifact-ref';
            a.textContent = f.worded ? text.slice(f.start, f.end) : `artifact ${id.slice(0, 8)}`; // a worded id keeps the digits it was written with
            a.title = `coral://artifacts/${id}`;
            frag.append(a);
            at = f.end;
            changed = true;
        }
        if (at === 0) continue;
        if (at < text.length) frag.append(text.slice(at));
        n.replaceWith(frag);
    }
    if (changed && after) after(root);
    return changed;
}
