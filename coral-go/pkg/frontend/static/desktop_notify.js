/* Desktop alerts for "an agent needs input" (N1) and, since #10068, "an agent finished a reply".
 *
 * Deliberately small: the page raises a Notification itself while it is open in a background tab. No service worker, no
 * push subscription, nothing stored on the server. It is off until this browser opts in, and the opt-in lives in this
 * browser's localStorage only. The text carries names, never agent output: no summary, prompt, path or tool input. */
import { browserLocal } from './safe_storage.js';
export const DESKTOP_NOTIFY_KEY = 'coral-desktop-notify';
// Which alerts this browser wants, and whether they make a sound (this browser only, like the opt-in itself; #10068).
export const ALERT_NEEDS_INPUT_KEY = 'coral-alert-needs-input'; // on unless turned off
export const ALERT_FINISHED_KEY = 'coral-alert-finished';       // on unless turned off
export const ALERT_SOUND_KEY = 'coral-alert-sound';             // off unless turned on
const PREF_DEFAULTS = { needsInput: [ALERT_NEEDS_INPUT_KEY, true], finished: [ALERT_FINISHED_KEY, true], sound: [ALERT_SOUND_KEY, false] };
const MAX_NAME = 60;
const MIN_GAP_MS = 30000, PER_MINUTE = 10; // per agent, and overall
const lastByTag = new Map(), recent = [];

function api() { return typeof Notification === 'undefined' ? null : Notification; }
function read() { try { return browserLocal.get(DESKTOP_NOTIFY_KEY) === '1'; } catch { return false; } }
function write(on) { try { if (on) browserLocal.set(DESKTOP_NOTIFY_KEY, '1'); else browserLocal.remove(DESKTOP_NOTIFY_KEY); } catch { /* storage blocked */ } }

export function desktopNotifySupported() { return !!api(); }

/** The alerts this browser wants: { needsInput, finished, sound }. */
export function alertPrefs() {
    const out = {};
    for (const [name, [key, dflt]] of Object.entries(PREF_DEFAULTS)) {
        let v = null;
        try { v = browserLocal.get(key); } catch { /* storage blocked */ }
        out[name] = v == null ? dflt : v === '1';
    }
    return out;
}

/** Set one of them (needsInput, finished or sound). */
export function setAlertPref(name, on) {
    const spec = PREF_DEFAULTS[name];
    if (!spec) return;
    try { browserLocal.set(spec[0], on ? '1' : '0'); } catch { /* storage blocked */ }
}

/** True when the browser itself blocks alerts from this site: turning them on cannot work until the person allows them in the browser. */
export function desktopNotifyBlocked() {
    const N = api();
    return !!N && N.permission === 'denied';
}

/** On only when this browser opted in AND the browser still grants permission. */
export function desktopNotifyEnabled() {
    const N = api();
    return !!N && read() && N.permission === 'granted';
}

/** Ask for permission (call from a click) and remember the answer. Resolves to whether alerts are now on. */
export async function enableDesktopNotify() {
    const N = api();
    if (!N) return false;
    let perm = N.permission;
    if (perm === 'default') {
        try { perm = await N.requestPermission(); } catch { perm = 'denied'; }
    }
    const on = perm === 'granted';
    write(on);
    return on;
}

export function disableDesktopNotify() { write(false); }

/** A display name reduced to short plain text: control and bidi characters removed, length capped. */
export function safeName(v) {
    const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
    return s.length > MAX_NAME ? s.slice(0, MAX_NAME - 1) + '…' : s;
}

/** The only text an alert may carry: who, what happened (needs input, or finished a reply) and where. */
export function alertText(agent, where, kind = 'needs_input') {
    const a = safeName(agent) || 'An agent';
    const w = safeName(where);
    const what = kind === 'finished' ? 'finished a reply' : 'needs input';
    return { title: 'Coral', body: w ? `${a} ${what} on ${w}` : `${a} ${what}` };
}

/** Raise one alert for an agent that needs the person ('needs_input') or finished a reply ('finished'), when this browser opted in and wants that kind. Only while the page is hidden. Returns the alert or null.
 *  A sound is the system's own alert sound, and only when this browser turned it on. */
export function notifyAttention(kind, { agent, where, tag, onClick } = {}) {
    const N = api();
    if (!N || !desktopNotifyEnabled()) return null;
    const prefs = alertPrefs();
    if (kind === 'finished' ? !prefs.finished : !prefs.needsInput) return null;
    if (typeof document !== 'undefined' && !document.hidden) return null; // the in-page toast covers a visible page
    const now = Date.now();
    while (recent.length && now - recent[0] >= 60000) recent.shift();
    const key = `${kind}:${String(tag || agent || '')}`;
    if (recent.length >= PER_MINUTE || now - (lastByTag.get(key) ?? -Infinity) < MIN_GAP_MS) return null;
    if (lastByTag.size > 500) lastByTag.clear();
    lastByTag.set(key, now); recent.push(now);
    const { title, body } = alertText(agent, where, kind);
    const prefix = kind === 'finished' ? 'finished' : 'needs-input';
    try {
        const n = new N(title, { body, tag: tag ? `${prefix}:${String(tag).slice(0, 200)}` : undefined, silent: !prefs.sound });
        n.onclick = () => {
            try { window.focus(); } catch { /* ignore */ }
            if (onClick) onClick();
            n.close();
        };
        return n;
    } catch { return null; }
}

/** Raise one alert for a session that just started waiting. Only while the page is hidden. Returns the alert or null. */
export function notifyNeedsInput(who) { return notifyAttention('needs_input', who); }

/** Test hook: forget the rate-limit history. */
export function _resetRateForTests() { lastByTag.clear(); recent.length = 0; }
