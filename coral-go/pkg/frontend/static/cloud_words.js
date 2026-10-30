/* The words of Settings > Network and Hub > Coral Hub that are decisions, not layout (#6555, #6579): a pure module, node-tested.
 *   morePermsWords: the summary of the closed "More Coral Hub permissions": which permissive switches are ON (named), and a warning when the protective one is OFF.
 *   operatorLine:   where the Operator switch's state is said outside the closed disclosure (the most consequential of them, Security's #6559).
 *   spellCode:      a one-time code as a screen reader should say it ("W X Y Z, 1 2 3 4"): a code read as a word is useless.
 *   describe, rekeyText, enrolledRetrying, autoAcceptChangedText, severalAccountsText and the fixed sentences: what the connect panel says about the status (#8386). */

const list = items => items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];

/** { text, warn }: "More Coral Hub permissions: may change cross-team settings and act as the Operator" or ": none on"; warn is the sentence for tokens that are visible to view-only hub users, or ''.
 *  `st` is the connector status, `operatorOn` whether the Operator switch is on (true, false, or null when this page cannot tell). */
export function morePermsWords(st, operatorOn) {
    const on = [];
    if (st && st.hub_cross_team_settings !== false) on.push('change cross-team settings');
    if (operatorOn === true) on.push('act as the Operator');
    if (st && st.hub_relaunch_updates === true) on.push('relaunch Coral to install updates');
    return {
        text: 'More Coral Hub permissions: ' + (on.length ? 'may ' + list(on) : 'none on'),
        warn: st && st.redact_tokens === false ? 'Tokens are visible to view-only hub users' : '',
    };
}

/** The Operator's state as a sentence for the status area, or '' when it does not apply (not linked, or this page cannot tell). */
export function operatorLine(operatorOn) {
    if (operatorOn === true) return 'Coral Hub may act as the Operator.';
    if (operatorOn === false) return 'Coral Hub may not act as the Operator.';
    return '';
}

/** "WXYZ-1234" as "W X Y Z, 1 2 3 4": the letters and digits said apart, the dash a pause. */
export function spellCode(code) {
    return String(code == null ? '' : code).split('-').map(part => [...part].join(' ')).filter(Boolean).join(', ');
}

// ── the status sentences and the confirm texts of the connect panel (moved from cloud_connect.js, #8386)

// Said when this server has no hub (a dev build, or --cloud-url off); the CLI says the same (#3285).
export const OFF_TEXT = "Coral Hub isn't configured on this computer. Start Coral with --cloud-url https://app.coralhub.dev (or CORAL_CLOUD_URL=https://app.coralhub.dev), then run: coral cloud connect";

// What the Hub may do at each level, as the sentence after "may now:" said once a change is saved.
export const LEVEL_NOW = { view: 'look only', interact: 'send and answer', launch: 'start agents' };

const cleanLabel = v => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 80); // display text: no control or bidi characters, bounded

/** "Turned on from Coral Hub by <user>, <time>" / "Turned off on this computer, <time>" from the status; '' when it was never changed. The state is the switch's own: the last change set it. */
export function autoAcceptChangedText(st) {
    const c = st && st.allow_hub_auto_accept_changed;
    if (!c || typeof c !== 'object' || (c.by !== 'hub' && c.by !== 'local')) return '';
    const d = typeof c.at === 'string' ? new Date(c.at) : null;
    const at = d && !Number.isNaN(d.getTime()) ? d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
    const what = st.allow_hub_auto_accept === false ? 'Turned off' : 'Turned on';
    const who = c.by === 'hub' ? `from Coral Hub by ${cleanLabel(c.user) || 'a Coral Hub user'}` : 'on this computer';
    return `${what} ${who}${at ? ', ' + at : ''}`;
}

/** Enrolled, but the tunnel is down and retrying (the hub approved the code, then was
 *  unreachable): the server is connected to the hub as far as the user is concerned. A
 *  'retrying' without an enrollment (no server id or label) is still not connected. */
export function enrolledRetrying(st) {
    return !!st && st.state === 'retrying' && !!(st.server_id || st.label);
}

/** The secret key that seals the Hub token and the remote servers' API keys is refused (#3698):
 *  what a re-key discards, said before the Operator confirms. */
export function rekeyText(sk) {
    const lost = [];
    if (sk.hub_url) lost.push('the Coral Hub connection to ' + sk.hub_url + ' (connect again afterwards, and remove this computer in Coral Hub)');
    if (sk.remote_server_keys) lost.push(sk.remote_server_keys === 1 ? "1 remote computer's API key (enter it again)" : sk.remote_server_keys + " remote computers' API keys (enter them again)");
    const why = sk.exposed ? 'Other accounts on this computer could read the secret key file, so what it protects must be treated as known.'
        : "Coral can't use its secret key file" + (sk.message ? ' (' + sk.message + ')' : '') + '.';
    return why + ' Replacing it makes a new key and discards ' + (lost.length ? lost.join(' and ') : 'nothing stored yet') + '.';
}

export function describe(st) {
    switch (st.state) {
        case 'off':
            return OFF_TEXT;
        case 'idle':
            if (codeExpired(st)) return EXPIRED_TEXT + HUB_ACCESS_URL;
            // The two failures of starting a connection are sentences for a person (#5962); the seconds until the next try are counted down beside them (syncRetry), not baked into the words.
            if (st.last_error_code === 'hub_unreachable') return 'Coral could not reach Coral Hub. Check your connection and try again.';
            if (st.last_error_code === 'rate_limited') return 'Coral Hub is busy. Try again in a moment.';
            return st.last_error || ('Ready to connect to ' + st.hub_url + '. Nothing is sent until you connect.');
        case 'enrolling':
            return 'Waiting for you to approve…';
        case 'connecting':
            return 'Connecting' + (st.label ? ' as "' + st.label + '"' : '') + '…';
        case 'connected':
            return 'Connected to Coral Hub' + (st.label ? ' as ' + st.label : '') + '.';
        case 'retrying':
            if (enrolledRetrying(st)) return 'Connected to Coral Hub' + (st.label ? ' as ' + st.label : '') + ' (reconnecting…). Coral keeps working locally meanwhile.';
            return 'Not connected right now (' + (st.last_error || 'retrying') + '). Coral keeps working locally and will reconnect on its own.';
        case 'revoked':
            return 'The hub revoked this computer, so Coral stopped retrying. Connect again to re-enroll.';
        case 'key_unreadable':
            return st.last_error;
        case 'upgrade_required':
            return st.last_error;
        default:
            return st.state;
    }
}

// Coral Hub never says why a code went unapproved (that would leak who is in the beta), so an
// expired code may mean the user could not sign in at all: say so, with where to ask for access.
export const HUB_ACCESS_URL = 'https://coralhub.dev/hub.html';
export const EXPIRED_TEXT = "The code expired before it was approved. If you couldn't sign in at app.coralhub.dev, Coral Hub is in closed beta: request access at ";

/** An idle status after a code expired (last_error_code, #3285). */
export function codeExpired(st) {
    return st.state === 'idle' && st.last_error_code === 'code_expired';
}

// The refusal when more than one Coral Hub account was named as the owner in the last hour (#6186), with the time the computer will accept Confirm owner again (retry_after, in seconds).
export function severalAccountsText(retryAfter) {
    const base = 'More than one Coral Hub account tried this; check who has access, then try again';
    if (!Number.isFinite(retryAfter) || retryAfter <= 0) return base + '.';
    const at = new Date(Date.now() + retryAfter * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `${base} after ${at}.`;
}
