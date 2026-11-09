/* Run scripts in an HTML file's preview, only when the person says so (#14730, design v3). Loaded on demand (importOnce) by artifact_preview.js for the single-artifact viewer.
 *
 * Trust is one exact version of the file (its digest), kept on the computer that holds it (GET/PUT/DELETE /api/artifacts/{digest}/trust-preview, owner only). The page that
 * runs is artifact_host.html in a frame with sandbox="allow-scripts" and nothing else: no same-origin access, no cookies, no storage, no popups, no forms, no device (allow="").
 * Its own policy (header and meta) blocks every request; the file's HTML is posted into it ONCE, after Coral has hashed the bytes it fetched and found them equal to the
 * digest that was trusted. Any other answer (a failed read of the trust, a different hash, a file over 2 MiB, no way to hash) leaves scripts OFF, with the plain preview. */
import { serverFetch } from './server_base.js';

export const MAX_SCRIPT_HTML_BYTES = 2 * 1024 * 1024;
const HOST_URL = '/static/artifact_host.html';
const MAX_HEIGHT = 20000;
export const HEIGHT_GAP_MS = 250;
const HEX_RE = /^[a-f0-9]{64}$/;

/** Is this digest trusted to run scripts? true only on a clean 200 `{trusted:true}`; anything else (an error, a refusal, a network failure, odd JSON) is false: it fails closed. */
export async function readTrust(hex, server, fetchFn = serverFetch) {
    if (!HEX_RE.test(hex)) return false;
    try {
        const resp = await fetchFn(server, `/api/artifacts/${hex}/trust-preview`, { cache: 'no-store' });
        if (!resp.ok) return false;
        const data = await resp.json();
        return data && data.trusted === true;
    } catch { return false; }
}

/** PUT (on) or DELETE (off) the trust of this digest; the answer is the stored state, or null when the call failed. */
export async function writeTrust(hex, server, on, fetchFn = serverFetch) {
    if (!HEX_RE.test(hex)) return null;
    try {
        const resp = await fetchFn(server, `/api/artifacts/${hex}/trust-preview`, { method: on ? 'PUT' : 'DELETE' });
        if (!resp.ok) return null;
        const data = await resp.json();
        return data && typeof data.trusted === 'boolean' ? data.trusted : null;
    } catch { return null; }
}

/** The SHA-256 of `html` (as the UTF-8 bytes the server stored), in lower-case hex; '' when this page cannot hash (an insecure connection). */
export async function sha256Hex(html) {
    try {
        if (!globalThis.crypto || !crypto.subtle) return '';
        const sum = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(html));
        return [...new Uint8Array(sum)].map(b => b.toString(16).padStart(2, '0')).join('');
    } catch { return ''; }
}

/** Does a newer version of this file exist? Trust is per exact version, so a newer one starts untrusted. false when the list cannot be read or the file is in no series (the line is left out, never guessed). */
export async function newerVersionExists(hex, server, board = '', fetchFn = serverFetch) {
    if (!HEX_RE.test(hex)) return false;
    try {
        const resp = await fetchFn(server, `/api/artifacts/${hex}/versions${board ? `?board=${encodeURIComponent(board)}` : ''}`);
        if (!resp.ok) return false;
        const rows = await resp.json();
        if (!Array.isArray(rows)) return false;
        const me = rows.find(r => r && r.digest === hex);
        return !!me && rows.some(r => r && Number(r.version) > Number(me.version));
    } catch { return false; }
}

/** The clamped whole number a file may ask for as its height; null for anything else. */
export function clampHeight(h) {
    return typeof h === 'number' && Number.isFinite(h) ? Math.max(0, Math.min(MAX_HEIGHT, Math.floor(h))) : null;
}

/** A one-line note under the preview's notice (a limit, a refusal). */
export function drawNote(wrapper, text) {
    const note = bar('artifact-scripts-line', text);
    note.setAttribute('role', 'status');
    const first = wrapper.querySelector('.artifact-linked-notice, .artifact-scripts-bar');
    if (first) first.after(note); else wrapper.prepend(note);
    return note;
}

function bar(className, text) {
    const el = document.createElement('p');
    el.className = `${className} notice notice-info notice-bar`; // not .artifact-linked-notice: the viewer's chip and first-time hiding belong to the plain banner
    el.append(text);
    return el;
}

function button(label, className, onClick) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = `btn ${className || ''}`.trim(); b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
}

/** The running frame: the host document, scripts only, the HTML handed over once when both the host is ready and Coral's check passed. */
function scriptFrame(html, name, { onNavigated }) {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-label', `Preview of ${name || 'artifact'}, scripts on`);
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('allow', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    let ready = false, sent = false, lastHeightAt = -Infinity;
    const handler = e => {
        if (e.source !== frame.contentWindow) return; // only this host
        const m = e.data;
        if (!m || typeof m !== 'object') return;
        if (m.type === 'coral-artifact-host-ready') {
            if (ready) sent = false; // the host frame was reloaded (a move, Expand): hand the HTML over again
            ready = true;
            if (!sent && frame.contentWindow) { sent = true; frame.contentWindow.postMessage({ type: 'coral-artifact-load', html }, '*'); }
        } else if (m.type === 'coral-artifact-height') {
            // the file's one message: a whole number, never taller than the window, and at most one every 250 ms (a file that asks over and over is ignored, not obeyed)
            const now = Date.now();
            if (now - lastHeightAt < HEIGHT_GAP_MS) return;
            lastHeightAt = now;
            const h = clampHeight(m.height);
            if (h !== null && h >= 120) frame.style.minHeight = `${Math.min(h, Math.max(240, window.innerHeight))}px`;
        } else if (m.type === 'coral-artifact-navigated') onNavigated();
    };
    window.addEventListener('message', handler);
    frame.src = HOST_URL;
    frame.coralDetach = () => window.removeEventListener('message', handler);
    return frame;
}

/** Draw the file with its scripts running, under a bar OUTSIDE the frame that says so and holds Turn off. `turnOff()` is called when the person turns it off (after the record is deleted). */
export function drawScripted(wrapper, { html, name, turnOff, line }) {
    const strip = bar('artifact-scripts-bar', 'Scripts are on for this version of the file. Coral limits what they can reach: no web requests, no cookies, no files. ');
    strip.setAttribute('role', 'status');
    const off = button('Turn off', 'artifact-scripts-off', () => { off.disabled = true; turnOff(); });
    strip.append(off);
    const frame = scriptFrame(html, name, {
        onNavigated: () => { frame.coralDetach(); frame.remove(); wrapper.append(bar('artifact-scripts-line', 'The file tried to leave this page and was stopped. Scripts are off.')); },
    });
    wrapper.replaceChildren(strip);
    if (line) wrapper.append(bar('artifact-scripts-line', line));
    wrapper.append(frame);
    return frame;
}

/** The offer under the plain preview's notice: "Run scripts…" opens a confirmation in place; Run scripts trusts THIS version, then `onTrusted()` redraws. */
export function drawOffer(wrapper, { hex, server, onTrusted, fetchFn = serverFetch }) {
    const row = document.createElement('div');
    row.className = 'artifact-scripts-offer';
    const ask = button('Run scripts…', 'artifact-scripts-ask', () => {
        ask.hidden = true;
        const box = document.createElement('div');
        box.className = 'artifact-scripts-sure'; box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Run scripts in this file');
        const words = document.createElement('p');
        words.textContent = 'This file can run scripts. They can draw and animate. Coral limits what they can reach: no web requests, no cookies, no files. Do not trust a file you would not open.';
        const msg = document.createElement('p'); msg.className = 'artifact-scripts-msg'; msg.setAttribute('role', 'status');
        const go = button('Run scripts', 'btn-primary artifact-scripts-go', async () => {
            go.disabled = true;
            const on = await writeTrust(hex, server, true, fetchFn);
            if (on === true) onTrusted();
            else { go.disabled = false; msg.textContent = 'Could not turn scripts on. Nothing was changed.'; }
        });
        const cancel = button('Cancel', 'artifact-scripts-cancel', () => { box.remove(); ask.hidden = false; ask.focus(); });
        const actions = document.createElement('div'); actions.className = 'artifact-scripts-actions'; actions.append(go, cancel);
        box.append(words, actions, msg);
        row.append(box);
        go.focus();
    });
    row.append(ask);
    const notice = wrapper.querySelector('.artifact-linked-notice');
    if (notice) notice.after(row); else wrapper.prepend(row);
    return row;
}
