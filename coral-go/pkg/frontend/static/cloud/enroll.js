/* Two-phase server enrollment.
 *
 * Phase 1 (preview): look the code up and show WHO is asking: the connecting
 * machine's IP, hostname, Coral version and time. Nothing is granted.
 * Phase 2 (approve): only an explicit click confirms, after a plain warning
 * that approving gives that machine access to this account.
 *
 * Every value from the server is rendered with textContent.
 *
 * Optional pairing hook (device keys, step 1): a same-origin file Coral serves (the page's CSP
 * allows only 'self' scripts) may define window.CoralPairing = Object.freeze({ beforeConfirm,
 * afterConfirm }) before this file runs. It is read once, at load, and only if frozen. The hook
 * sees a copy of user_code and label (never the CSRF token or the nonce) and may only ADD
 * fields from PAIRING_FIELDS; a hook that throws, hangs or returns anything else changes
 * nothing, and the confirm goes ahead without it. */

import { safeNext, getSession, postJSON, setStatus } from './common.js';

const $ = id => document.getElementById(id);
const CODE_RE = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/;

function normalizeCode(v) {
    const c = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return c.length === 8 ? c.slice(0, 4) + '-' + c.slice(4) : String(v || '').toUpperCase().trim();
}

function fact(dl, name, value) {
    const dt = document.createElement('dt'); dt.textContent = name;
    const dd = document.createElement('dd'); dd.textContent = value || 'unknown';
    dl.append(dt, dd);
}

// The only keys a pairing hook may add to the confirm body, each a string of at most
// PAIRING_MAX_LEN characters. user_code, label and nonce are never in this list.
const PAIRING_FIELDS = Object.freeze(['device_public_key', 'device_key_proof']);
const PAIRING_MAX_LEN = 2048;
const PAIRING_TIMEOUT_MS = 3000;

// The hook as it stood when the page loaded: frozen, with function members, or none.
function readPairingHook() {
    try {
        const h = typeof window !== 'undefined' ? window.CoralPairing : undefined;
        if (!h || typeof h !== 'object' || !Object.isFrozen(h)) return null;
        const before = typeof h.beforeConfirm === 'function' ? h.beforeConfirm : null;
        const after = typeof h.afterConfirm === 'function' ? h.afterConfirm : null;
        return (before || after) ? { before, after, self: h } : null;
    } catch (_) { return null; }
}

function isPlainObject(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const p = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null;
}

// What a hook may add: own, listed keys with string values of a bounded length.
function pairingExtras(out) {
    const extras = {};
    if (!isPlainObject(out)) return extras;
    for (const k of PAIRING_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(out, k)) continue;
        const v = out[k];
        if (typeof v === 'string' && v.length > 0 && v.length <= PAIRING_MAX_LEN) extras[k] = v;
    }
    return extras;
}

function withTimeout(p, ms) {
    let t;
    return Promise.race([Promise.resolve(p), new Promise(res => { t = setTimeout(() => res(undefined), ms); })]).finally(() => clearTimeout(t));
}

function fmtTime(ts) {
    const t = Date.parse(ts);
    return Number.isNaN(t) ? 'unknown' : new Date(t).toLocaleString() + ` (${Math.max(0, Math.round((Date.now() - t) / 1000))}s ago)`;
}

(async function init() {
    const here = location.pathname + location.search;
    const s = await getSession();
    if (!s.authenticated) { location.replace('/signin?next=' + encodeURIComponent(safeNext(here, '/enroll'))); return; }

    const pairing = readPairingHook(); // before anything else on the page can replace it
    const entry = $('entry'), review = $('review'), done = $('done');
    const status = $('status');
    const codeInput = $('code');
    let csrf = s.csrf;
    let code = '';

    let nonce = '';

    async function preview(raw) {
        code = normalizeCode(raw);
        if (!CODE_RE.test(code)) { setStatus(status, 'Enter the code shown on your machine (XXXX-XXXX).', 'error'); return; }
        setStatus(status, 'Looking up…');
        const r = await postJSON('/api/enroll/preview', { user_code: code }, csrf);
        if (r.status === 404) { setStatus(status, 'That code is invalid, expired, or already used. Start again on your machine.', 'error'); return; }
        if (r.status === 429) { setStatus(status, 'Too many attempts. Wait a few minutes and try again.', 'error'); return; }
        if (!r.ok || !r.data || !r.data.nonce) { setStatus(status, 'Could not check the code. Try again.', 'error'); return; }
        const q = r.data.requester || {};
        nonce = r.data.nonce;
        // What the hub itself observed goes first: it cannot be faked by the machine.
        const seen = $('seen'); seen.replaceChildren();
        fact(seen, 'Code', code);
        fact(seen, 'From IP address', q.ip);
        fact(seen, 'Requested', fmtTime(q.requested_at));
        const rep = $('reported'); rep.replaceChildren();
        fact(rep, 'Machine name', q.hostname);
        fact(rep, 'Coral version', q.coral_version);
        $('label').value = (q.hostname || '').slice(0, 100);
        entry.hidden = true; review.hidden = false;
        setStatus(status, '');
        $('label').focus();
    }

    $('entry-form').addEventListener('submit', e => { e.preventDefault(); preview(codeInput.value); });

    $('cancel').addEventListener('click', () => { review.hidden = true; entry.hidden = false; codeInput.value = ''; code = ''; nonce = ''; setStatus(status, ''); });

    $('approve').addEventListener('click', async () => {
        const label = $('label').value.trim();
        if (!label) { setStatus(status, 'Enter a name for this machine.', 'error'); return; }
        $('approve').disabled = true;
        setStatus(status, 'Approving…');
        let extras = {};
        if (pairing && pairing.before) {
            try { extras = pairingExtras(await withTimeout(pairing.before.call(pairing.self, Object.freeze({ user_code: code, label })), PAIRING_TIMEOUT_MS)); }
            catch (_) { extras = {}; }
        }
        const r = await postJSON('/api/enroll/confirm', { ...extras, user_code: code, label, nonce }, csrf);
        if (pairing && pairing.after) {
            try { // the reply only, as a copy; never awaited, so it cannot hold up the page
                const reply = Object.freeze({ status: r.status, ok: !!r.ok, data: r.data === undefined ? undefined : JSON.parse(JSON.stringify(r.data)) });
                Promise.resolve(pairing.after.call(pairing.self, reply)).catch(() => {});
            } catch (_) { /* a refusal never blocks the confirm */ }
        }
        if (r.ok) {
            review.hidden = true; done.hidden = false; setStatus(status, '');
        } else if (r.status === 409) {
            setStatus(status, 'You have reached the limit of connected machines. Revoke one first.', 'error'); $('approve').disabled = false;
        } else if (r.status === 404) {
            setStatus(status, 'That code is no longer valid. Start again on your machine.', 'error'); $('approve').disabled = false;
        } else if (r.status === 429) {
            setStatus(status, 'Too many attempts. Wait a few minutes and try again.', 'error'); $('approve').disabled = false;
        } else {
            setStatus(status, 'Could not confirm approval. Check whether the machine connected before trying again.', 'error'); $('approve').disabled = false;
        }
    });

    const q = new URLSearchParams(location.search).get('code');
    if (q) { codeInput.value = normalizeCode(q); preview(q); }
    else codeInput.focus();
})();
