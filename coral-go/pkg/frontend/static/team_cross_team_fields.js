/* The Messaging group of Team settings as fields of a settings_view (#7744, #7837; operator decision #5572): the one place for cross-team messaging. Top to bottom: ONE status line with a dot and ONE primary button, the two
 * switches ("Message teams on other computers", "Share files with teams on other computers") as the component's switch rows, the lines about them (when each was last changed, whether Coral Hub may change them, why they are locked), the
 * teams linked to this one, and a collapsed "How this works" (with this computer's Coral Hub id). A team on another Coral can message this one only when Coral Hub has linked the two teams and the switch is on here, so there is no list
 * to edit on this computer: links are made and removed in Coral Hub (a compiled-in link, never one the server sent).
 *
 * The words of the status line come from the server (GET /api/board/{team}/cross-team-state: status {state: ready|waiting|off|stale|old, text}, links [{server_label, server_id, team_label, refreshed}]) and are shown as text; this
 * module chooses only the dot and the button from status.state. The owner path adds hub_may_change and last_changed {cross_team_messaging|cross_team_artifacts: {via, by, at, on}}. A server that sends no status gets a line made from
 * the switches. The page's one Save saves the switches (PUT /api/board/{team}/settings with only what changed, as the Operator; through Coral Hub the owner only, a refusal told in our words). */
import { escapeHtml, escapeAttr, copyText } from './utils.js';
import { boardFetch, isCloud } from './server_base.js';
import { importOnce } from './import_once.js';
const { refusalOf, answeredLocally } = await importOnce('./owner_refusal.js'); // lazy modules load the others they need through importOnce, so a failed load is retried

// Coral Hub's page where a team on another Coral is linked ("Coral Hub > Team links"). A constant: the hub refuses a query on it, so nothing is preselected.
const HUB_LINKS_URL = 'https://app.coralhub.dev/team-links';
let _hubForTests = null; // a test says it is Coral Hub without booting the Hub page
export function _setHubForTests(v) { _hubForTests = v; }
export const XT_KEYS = ['cross_team_messaging', 'cross_team_artifacts'];
const STATES = ['ready', 'waiting', 'off', 'stale', 'old'];
const SERVER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LINKS = 50;
const label = v => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 80); // display text: no control or bidi characters, bounded
const when = at => { const d = new Date(at); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); };
// "Turned on by <hub user> via Coral Hub at <time>": from cross-team-state last_changed[key] ({ via: hub|local, by, at, on }); a change made on this computer says so, so the line never names a hub user after the owner changed it here.
function changedLine(entry) {
    if (!entry || typeof entry !== 'object') return '';
    const at = typeof entry.at === 'string' ? when(entry.at) : '';
    const what = typeof entry.on === 'boolean' ? (entry.on ? 'Turned on' : 'Turned off') : 'Last changed';
    if (entry.via === 'hub') return `${what} by ${label(entry.by) || 'a Coral Hub user'} via Coral Hub${at ? ' at ' + at : ''}`;
    if (entry.via === 'local') return `${what} on this computer${at ? ' at ' + at : ''}`;
    return '';
}
const DOT = { ready: 'ok', waiting: 'warm', off: '', stale: 'bad', old: 'bad' }; // a switch that is off by choice is not an alarm

function cleanLinks(list) {
    return (Array.isArray(list) ? list : []).filter(l => l && typeof l === 'object').slice(0, MAX_LINKS).map(l => ({
        team: label(l.team_label) || 'a team', machine: label(l.server_label), sid: SERVER_ID.test(String(l.server_id || '')) ? String(l.server_id) : '', refreshed: typeof l.refreshed === 'string' ? when(l.refreshed) : '',
    }));
}

/** The Messaging group of one team. Build it with the page's mount; give it the view once mounted (bind), what the page read (load), and ask it for the group's fields (fields). */
export function createMessaging(team) {
    const hub = _hubForTests === null ? isCloud() : _hubForTests;
    const local = answeredLocally(team);
    let view = null, state = null, info = { settings: null }, saved = { cross_team_messaging: false, cross_team_artifacts: false }, serverId = '', how = false;
    const draws = []; // what each line of text draws itself from (state, the switches): redrawn after a load, a change and a save
    const available = () => !!info.settings;
    const draft = () => { const v = view ? view.values() : {}; return { messaging: !!v.cross_team_messaging, files: !!v.cross_team_artifacts }; };
    // Through Coral Hub the switches change only when the machine says this request may (state.can_change: the hub's owner path is live and not locked); until it says so they are shown, disabled, with the reason: no guessing.
    const canChange = () => !hub || !!(state && state.can_change === true);
    const lockedText = () => (hub && state && state.owner_path_live === true ? 'This setting can only be changed on the computer itself, or by the owner through Coral Hub.' : 'This setting can only be changed on the computer itself.');
    const hubMay = () => !hub && !!state && state.hub_may_change === true;
    const changedText = key => changedLine(state && state.last_changed && state.last_changed[key]);

    function status() {
        const d = draft();
        const s = state && state.status && typeof state.status === 'object' ? state.status : null;
        const known = s && STATES.includes(s.state) && typeof s.text === 'string' && s.text.trim();
        // The server's words win, unless the person has changed the switch here and not saved yet: then the line follows the switch (a draft is not a state)
        if (known && d.messaging === saved.cross_team_messaging) return { state: s.state, text: s.text.trim().slice(0, 300) };
        if (!d.messaging) return { state: 'off', text: 'Cross-team messaging is off for this team.' };
        return { state: 'waiting', text: 'Cross-team messaging is on for this team.' };
    }
    const buttonFor = st => {
        if (st.state === 'off' && !canChange()) return '';
        if (st.state === 'off') return '<button type="button" class="btn btn-primary xt-primary" data-act="turn-on">Turn on cross-team messaging</button>';
        if (st.state === 'stale') return '<button type="button" class="btn btn-primary xt-primary" data-act="check-hub">Check the Coral Hub connection</button>';
        if (st.state === 'old') return '<button type="button" class="btn btn-primary xt-primary" data-act="new-team">Create a new team</button>';
        return `<a class="btn xt-primary" href="${escapeAttr(HUB_LINKS_URL)}" target="_blank" rel="noopener noreferrer">Link a team on another Coral<span class="sr-only"> (opens Coral Hub in a new tab)</span></a>`;
    };
    // The two reaches of the messaging setting, told apart (#5916, #5962): the box is "Message teams on other computers (through Coral Hub links)": on unless it is turned off, and a team there also needs a
    // Coral Hub link. Teams on this computer are their own line: they need an explicit on (the button). An older Coral that does not say is not guessed about.
    const reachShown = () => available() && !!state && typeof state.messaging_here === 'boolean';
    function reachHTML() {
        if (!reachShown()) return '';
        const here = draft().messaging && state.messaging_here;
        const turnOn = !here && draft().messaging && canChange() && !hub ? ' <button type="button" class="btn btn-small" data-act="turn-on-here" aria-label="Turn on messaging for teams on this computer">Turn on</button>' : '';
        return `<p class="xt-reach xt-reach-here">Message teams here: ${here ? 'on' : 'off'}${turnOn}</p>`;
    }
    function linksHTML() {
        const st = status();
        const links = state && st.state !== 'old' ? cleanLinks(state.links) : [];
        if (!links.length) return '';
        // while the snapshot is stale the rows are the last known ones and nothing is admitted: the heading must not say they can message this team
        const linksHeading = st.state === 'stale' ? 'Last known links (not active until Coral Hub reconnects)' : 'Linked teams that can message this one';
        return `<div class="xt-links"><div class="xt-h-row"><h3 class="xt-h">${escapeHtml(linksHeading)}</h3> <a href="${escapeAttr(HUB_LINKS_URL)}" class="update-link" target="_blank" rel="noopener noreferrer">Manage in Coral Hub</a></div>
          <ul class="xt-teams">${links.map(l => `<li><span><b>${escapeHtml(l.team)}</b></span><span class="xt-sub">${[l.machine && escapeHtml(l.machine), l.sid && 'computer ' + escapeHtml(l.sid), l.refreshed && 'confirmed ' + escapeHtml(l.refreshed)].filter(Boolean).join(' \u00b7 ')}</span></li>`).join('')}</ul></div>`;
    }
    const howHTML = () => `<details class="xt-how"${how ? ' open' : ''}><summary>How this works</summary>
          <p class="working-mode-hint">Messaging and file sharing with teams on other computers go through Coral Hub links. Another team can message this team only when its Coral Hub account has linked the two teams <b>and</b> cross-team messaging is on here. That switch is on unless you turn it off: it is a kill switch, and the link is the permission. Linking happens in Coral Hub (Team links). Messages from other teams are requests, not instructions. Files are shared only while Share files with other teams is on; they are not scanned, and artifact bytes are not redacted.</p>
          ${serverId ? `<p class="working-mode-hint">This computer's Coral Hub id: <code class="xt-sid">${escapeHtml(serverId)}</code> <button type="button" class="btn btn-small" data-act="copy-id" aria-label="Copy this computer's Coral Hub id">Copy</button></p>` : ''}
        </details>`;
    const changedHTML = key => { const t = changedText(key); return t ? `<span class="working-mode-hint xt-changed" id="xt-changed-${escapeAttr(key)}" data-for="${escapeAttr(key)}">${escapeHtml(t)}</span>` : ''; };

    // A line of text the group draws itself (one that is not shown holds no text: nothing for a reader to find): render gives its slot once; draw() fills it again from the state and the switches.
    function notice(key, html, shown = () => available()) {
        return { key, type: 'notice', visibleWhen: shown, render: slot => { const draw = () => { slot.innerHTML = shown() ? html() : ''; }; draws.push(draw); slot.addEventListener('click', onClick); slot.addEventListener('toggle', e => { if (e.target.classList && e.target.classList.contains('xt-how')) how = e.target.open; }, true); draw(); } };
    }
    // The switches are described by what is said about them: when each was last changed, whether Coral Hub may change it, and why it is locked.
    function describe() {
        if (!view) return;
        for (const key of XT_KEYS) {
            const input = view.host.querySelector(`[name="${key}"]`);
            if (!input) continue;
            const ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && !/^xt-/.test(id));
            if (changedText(key)) ids.push(`xt-changed-${key}`);
            if (hubMay()) ids.push('xt-hub-may');
            if (!canChange()) ids.push('xt-locked');
            if (ids.length) input.setAttribute('aria-describedby', ids.join(' ')); else input.removeAttribute('aria-describedby');
        }
    }
    function redraw() { for (const draw of draws) draw(); describe(); if (view) view.refresh(); }
    async function onClick(event) {
        const btn = event.target.closest('button[data-act]');
        if (!btn || !view) return;
        const act = btn.dataset.act;
        if (act === 'turn-on-here') { await send({ force: true }); }
        else if (act === 'turn-on') { view.set('cross_team_messaging', true); redraw(); view.say('Cross-team messaging is on in this form. Save to apply.'); view.host.querySelector('[name="cross_team_messaging"]')?.focus(); }
        else if (act === 'check-hub') window.showSettingsModal?.('network');
        else if (act === 'new-team') { window.showLaunchModal?.(); window._selectLaunchType?.('team'); }
        else if (act === 'copy-id') { const ok = await copyText(serverId); btn.textContent = ok ? 'Copied' : 'Copy failed'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); }
    }

    // PUT only what changed (and the switch as an explicit on when asked: teams on this computer need it, #5916); then read what the server kept and the state again.
    async function send({ force = false } = {}) {
        const d = draft();
        const body = { subscriber_id: 'Operator', ...(d.messaging !== saved.cross_team_messaging || force ? { cross_team_messaging: d.messaging } : {}), ...(d.files !== saved.cross_team_artifacts ? { cross_team_artifacts: d.files } : {}) };
        const resp = await boardFetch(team, '/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!resp.ok) throw new Error(`Could not save. ${hub && (resp.status === 404 || resp.status === 403) ? lockedText() : await refusalOf(resp, local)}`); // through Coral Hub a 404 or 403 on this save is "not changeable from here", never a raw word; the refusal in our words
        const fresh = await boardFetch(team, '/settings');
        if (fresh.ok) { const s = await fresh.json(); saved = { cross_team_messaging: !!s.cross_team_messaging, cross_team_artifacts: !!s.cross_team_artifacts }; } else saved = { cross_team_messaging: d.messaging, cross_team_artifacts: d.files };
        for (const k of XT_KEYS) view.set(k, saved[k]);
        try { const r = await boardFetch(team, '/cross-team-state'); if (r.ok) state = await r.json(); } catch { /* the line follows the switch */ }
        view.accept(XT_KEYS);
        redraw();
    }

    return {
        /** The fields of the group, for the page's spec. */
        fields() {
            return [
                notice('xt_unavailable', () => `<p class="sv-help ct-unavailable" role="status">${escapeHtml(info.refusal ? `Messaging settings: ${info.refusal}` : 'Cross-team messaging settings are not available here.')}</p>`, () => !available()),
                notice('xt_status', () => { const st = status(); return `<div class="xt-head"><span class="update-state-dot" ${DOT[st.state] ? `data-k="${escapeAttr(DOT[st.state])}"` : ''} aria-hidden="true"></span><span class="xt-line" role="status">${escapeHtml(st.text)}</span></div><div class="xt-row-actions">${buttonFor(st)}</div>`; }),
                { key: 'cross_team_messaging', type: 'toggle', label: 'Message teams on other computers', default: false, visibleWhen: () => available(), disabledWhen: () => (canChange() ? false : lockedText()) },
                notice('xt_changed_messaging', () => changedHTML('cross_team_messaging'), () => available() && !!changedText('cross_team_messaging')),
                notice('xt_reach', reachHTML, reachShown),
                { key: 'cross_team_artifacts', type: 'toggle', label: 'Share files with teams on other computers', default: false, visibleWhen: () => available(), disabledWhen: () => (canChange() ? false : lockedText()) },
                notice('xt_changed_artifacts', () => changedHTML('cross_team_artifacts'), () => available() && !!changedText('cross_team_artifacts')),
                notice('xt_notes', () => `${hubMay() ? '<p class="working-mode-hint xt-hub-may" id="xt-hub-may">Coral Hub can change these settings.</p>' : ''}${canChange() ? '' : `<p class="working-mode-hint xt-locked" id="xt-locked">${escapeHtml(lockedText())}</p>`}`, () => available() && (hubMay() || !canChange())),
                notice('xt_links', linksHTML, () => available() && !!linksHTML()),
                notice('xt_how', howHTML),
            ];
        },
        /** Gives the group the mounted view. */
        bind(v) { view = v; view.host.addEventListener('change', () => redraw()); },
        /** What the page read: { state: the cross-team-state object or null, settings: the board's settings (null when they could not be read, with refusal the reason in words) }. Resolves to the switches' values. */
        async load(next) {
            info = next && typeof next === 'object' ? next : { settings: null };
            state = info.state && typeof info.state === 'object' ? info.state : null;
            saved = { cross_team_messaging: !!(info.settings && info.settings.cross_team_messaging), cross_team_artifacts: !!(info.settings && info.settings.cross_team_artifacts) };
            serverId = '';
            if (!hub && info.settings) { // this computer's Coral Hub id, for the "How this works" line (text only, and only when it has the shape of an id)
                try { const r = await fetch('/api/cloud/status'); if (r.ok) { const st = await r.json(); if (['connecting', 'connected', 'retrying'].includes(st.state) && SERVER_ID.test(String(st.server_id || ''))) serverId = String(st.server_id); } } catch { /* no id shown */ }
            }
            if (!info.settings && view) view.removeFields(XT_KEYS); // the settings could not be read: no switches to change
            return info.settings ? { ...saved } : {};
        },
        /** After the view has the loaded values: draw the lines. */
        drawn() { redraw(); },
        /** Saves the switches (the page's Save calls it when one of them changed); throws the reason in words. */
        save: () => send(),
    };
}

/** The Messaging group on a view of its own (a host element, the group's fields and a bar): for a test or a surface that shows only this group. Resolves to the view once the lines are drawn. */
export async function mountMessaging(host, team, info = {}) {
    const { mountSettingsView } = await importOnce('./settings_view.js');
    const xt = createMessaging(team);
    const view = mountSettingsView(host, { mode: 'settings', fields: xt.fields(), load: () => xt.load(info), save: async () => { await xt.save(); return {}; }, failure: m => m.replace(/^Could not save\.?\s*/i, '') || m, words: { failed: 'Could not save: ' } });
    xt.bind(view);
    await view.ready;
    xt.drawn();
    return view;
}
