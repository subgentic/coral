/* The team's files as a person runs them (#15154, walk 5): where the team's folder is (with Copy path), and Download all, one zip of the files the list shows. Lazy: the Artifacts tab loads it when its list is drawn.
 * The zip is built here from the same routes the list already reads, one stored (uncompressed) entry per file, so no new server route is needed; the bytes are held in memory under the same 25 MiB limit as one download. */
import { MAX_DOWNLOAD_BYTES, sanitizeDownloadName } from './artifact_download.js';
import { teamFetch } from './server_base.js';
import { copyText, showToast } from './utils.js';

const folders = new Map(); // team -> its folder ('' when it has none), read once per page life
/** The team's own folder from its record ('' when it has none or the computer cannot say). */
export async function teamFolder(project) {
    if (folders.has(project)) return folders.get(project);
    let dir = '';
    try { const r = await teamFetch(project, n => `/api/teams/detail/${encodeURIComponent(n)}`); const d = r.ok ? await r.json() : null; dir = d && typeof d.working_dir === 'string' ? d.working_dir : ''; } catch { dir = ''; }
    folders.set(project, dir);
    return dir;
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** A zip of `files` ([{ name, bytes }], names already unique and safe), every entry stored whole: the local headers, the data, then the central directory. */
export function zipStored(files, now = new Date()) {
    const enc = new TextEncoder(), parts = [], central = [];
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    let offset = 0;
    for (const f of files) {
        const name = enc.encode(f.name), crc = crc32(f.bytes), size = f.bytes.length;
        const head = new DataView(new ArrayBuffer(30));
        head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true); head.setUint16(8, 0, true); head.setUint16(10, time, true); head.setUint16(12, date, true);
        head.setUint32(14, crc, true); head.setUint32(18, size, true); head.setUint32(22, size, true); head.setUint16(26, name.length, true); head.setUint16(28, 0, true);
        parts.push(head.buffer, name, f.bytes);
        const cd = new DataView(new ArrayBuffer(46));
        cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint16(10, 0, true); cd.setUint16(12, time, true); cd.setUint16(14, date, true);
        cd.setUint32(16, crc, true); cd.setUint32(20, size, true); cd.setUint32(24, size, true); cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
        central.push(cd.buffer, name);
        offset += 30 + name.length + size;
    }
    const cdSize = central.reduce((n, p) => n + (p.byteLength ?? p.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/octet-stream' });
}

/** Save the zip the way artifact_download.js saves one file: an octet-stream Blob (never a type a page could be run as), a sanitised name, a programmatic <a download> click, the blob URL revoked. */
function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    try { const a = document.createElement('a'); a.href = url; a.download = sanitizeDownloadName(name); a.rel = 'noopener'; a.hidden = true; document.body.appendChild(a); a.click(); a.remove(); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
}

/** Names that do not collide inside one zip: a second "app.js" becomes "app (2).js". */
export function uniqueNames(names) {
    const seen = new Map();
    return names.map(raw => {
        const n = sanitizeDownloadName(raw), k = n.toLowerCase(), c = (seen.get(k) || 0) + 1; seen.set(k, c);
        if (c === 1) return n;
        const dot = n.lastIndexOf('.');
        return dot > 0 ? `${n.slice(0, dot)} (${c})${n.slice(dot)}` : `${n} (${c})`;
    });
}

/** Fetch each file ({ url, name }) from this page's own routes and save them as one zip called `zipName`. Throws a readable Error when a file cannot be read or the total is over the limit. */
export async function downloadAllAsZip(files, zipName) {
    if (!files.length) throw new Error('There are no files to download.');
    const names = uniqueNames(files.map(f => f.name)), got = []; let total = 0;
    for (let i = 0; i < files.length; i++) {
        const target = new URL(files[i].url, window.location.href);
        if (target.origin !== window.location.origin || !target.pathname.startsWith('/api/')) throw new Error('Download refused: not a same-origin API link');
        const resp = await fetch(target.href, { method: 'GET', cache: 'no-store', credentials: 'same-origin' });
        if (!resp.ok) throw new Error(`${names[i]} could not be read (${resp.status}). Nothing was saved.`);
        const bytes = new Uint8Array(await resp.arrayBuffer()); total += bytes.length;
        if (total > MAX_DOWNLOAD_BYTES) throw new Error('These files are too big to zip here (limit 25 MiB). Download them one at a time.');
        got.push({ name: names[i], bytes });
    }
    saveBlob(zipStored(got), zipName.endsWith('.zip') ? zipName : `${zipName}.zip`);
    return got.length;
}

/** Fill `host` (a team list's strip): the folder with Copy path, and Download all for `files()` (the list's own files: filtered by a goal, they are that goal's). */
export async function fillStrip(host, { project, files, hasMore }) {
    const dir = await teamFolder(project);
    if (!host.isConnected && !host.parentNode) return;
    const row = document.createElement('div'); row.className = 'team-files-strip';
    if (dir) {
        const note = document.createElement('p'); note.className = 'goals-note'; note.append('The team works in the folder ');
        const code = document.createElement('code'); code.textContent = dir; note.append(code, '. The app runs from there: open index.html in that folder.');
        const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn btn-small'; copy.textContent = 'Copy path'; copy.setAttribute('aria-label', 'Copy the team folder path');
        copy.addEventListener('click', async () => { showToast((await copyText(dir)) === false ? 'Could not copy. Select the path and copy it.' : 'Folder path copied', false); });
        row.append(note, copy);
    }
    const all = document.createElement('button'); all.type = 'button'; all.className = 'btn btn-small'; all.textContent = 'Download all (zip)'; all.setAttribute('aria-label', 'Download the files shown as one zip');
    all.addEventListener('click', async () => {
        if (all.disabled) return; const list = files(); if (!list.length) { showToast('No file here can be downloaded.', true); return; } all.disabled = true; // never a silent button
        try { const n = await downloadAllAsZip(list, `${project}-files`); showToast(`Saved ${n} file${n === 1 ? '' : 's'} as a zip${hasMore() ? '. Only the files shown are in it: load more first for the rest.' : ''}`, false); }
        catch (e) { showToast(e && e.message ? e.message : 'The zip could not be made.', true); }
        finally { all.disabled = false; }
    });
    row.append(all);
    if (host.offsetHeight) host.style.minHeight = host.offsetHeight + 'px'; // a team with no folder has a shorter strip: it still holds the reserved height
    host.classList.remove('team-files-strip-reserve'); host.removeAttribute('aria-hidden');
    host.replaceChildren(row);
}
