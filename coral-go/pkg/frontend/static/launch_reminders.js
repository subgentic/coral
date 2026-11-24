// The Reminders tab of New agent's step 3 (#21169, the Operator: "just a tab like permissions in step 3"). The person adds, edits and removes reminders while making the agent; launching saves them for
// the new session through the same POST /api/reminders the agent's page uses (agent_reminders.js), so the same limits and words apply. Loaded with the dialog's first open of the tab, not at start.
// A reminder handed in by a template or a persona (setSource) says where it came from; one the person adds says it is theirs.
import { serverUrl, isCloud } from './server_base.js';
import { el } from './dom_el.js';
import { importOnce } from './import_once.js';
import { loadStyles } from './lazy_styles.js';
const { INTERVALS, scheduleWords } = await importOnce('./chief_checks_model.js');
const { KINDS, DAYS } = await importOnce('./agent_reminders.js');
await loadStyles('launch_reminders.css').catch(() => {});

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const button = (text, fn, cls = 'btn') => { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', fn); return b; };
let seq = 0;
export const MAX_REMINDERS = 5; // a persona or template role carries 5 at most (#21019, #21184), so does the tab
const FULL = `An agent starts with ${MAX_REMINDERS} reminders at most. Remove one to add another; more can be added on its page after it starts.`;

/** A draft in the words of POST /api/reminders: { text, kind: once|every|daily|weekdays|weekly, at, every_minutes }, plus where it came from (source) and whether the person changed it. */
export function draftWords(d) {
    if (d.kind === 'once') return `Once, ${String(d.at || '').replace('T', ' ')} · ${zone()}`;
    return scheduleWords({ schedule_kind: d.kind === 'every' ? 'interval' : d.kind, at: d.at, every_minutes: d.every_minutes, timezone: zone() });
}

/** The body POST /api/reminders takes for a draft made for the session sessionId. */
export function reminderBody(d, sessionId) {
    const body = { text: d.text, session_id: sessionId, kind: d.kind, timezone: d.kind === 'every' ? 'UTC' : d.timezone || zone() };
    if (d.no_wake) body.no_wake = true;
    if (d.kind === 'every') body.every_minutes = d.every_minutes; else body.at = d.at;
    return body;
}

/** Saves the drafts for the session just made, one request each. Resolves with how many were saved and the texts that were not. */
export async function saveReminders(drafts, sessionId, server) {
    let saved = 0; const failed = [];
    for (const d of drafts) {
        const r = await fetch(serverUrl('/api/reminders', server), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reminderBody(d, sessionId)) }).catch(() => null);
        if (r && r.ok) saved++; else failed.push(d.text);
    }
    return { saved, failed };
}

/** Mounts the tab's content in host. onChange(count) is called whenever the list changes. Returns { drafts(), setSource(name, list), reset() }. */
export function mountLaunchReminders(host, { who = () => 'this agent', onChange = () => {} } = {}) {
    if (isCloud()) { host.hidden = true; return { drafts: () => [], setSource() {}, reset() {} }; } // reminders are the person's own, on the computer: the Hub does not serve them (#19630)
    let items = [], editing = null; // editing: an item, or {} for a new one
    const id = `launch-rem-${++seq}`;
    const lead = el('p', 'launch-rem-lead', 'A reminder wakes this agent at a time you choose and stays open until it marks it done. You can add or change them later on the agent\'s page.');
    const cards = el('div', 'launch-rem-cards'), formHost = el('div'), say = el('p', 'chief-check-hint'); say.setAttribute('role', 'status');
    host.replaceChildren(lead, cards, formHost, say);
    const changed = () => { draw(); onChange(items.length); };
    function draw() {
        cards.replaceChildren();
        if (!items.length && !editing) {
            const empty = el('div', 'empty-state launch-rem-none'); empty.append(el('p', '', 'No reminders. This agent will only act when you or the team ask it to.'), button('Add a reminder', () => open({}), 'btn'));
            cards.append(empty);
        } else for (const it of items) cards.append(card(it));
        if (items.length && !editing) { const row = el('div', 'launch-rem-add'), add = button('Add a reminder', () => open({})); if (items.length >= MAX_REMINDERS) { add.disabled = true; row.append(add, el('span', 'chief-check-hint', FULL)); } else row.append(add); cards.append(row); }
    }
    function card(it) {
        const c = el('section', 'chief-check-card launch-rem-card'); c.setAttribute('aria-label', `Reminder: ${it.text}`);
        const top = el('div', 'launch-rem-top'); top.append(el('strong', '', draftWords(it)), el('span', it.source ? 'chip chip-tag launch-rem-chip launch-rem-chip-src' : 'chip chip-tag launch-rem-chip', it.source ? 'From the template' : 'Added by you'));
        const acts = el('div', 'chief-check-actions');
        const remove = button('Remove', () => {
            if (remove.dataset.confirm !== 'yes') { remove.dataset.confirm = 'yes'; remove.textContent = 'Confirm remove'; return; }
            items = items.filter(x => x !== it); say.textContent = 'Reminder removed.'; changed();
        }, 'btn btn-quiet launch-rem-remove'); remove.setAttribute('aria-label', `Remove the reminder ${it.text}`);
        acts.append(button('Edit', () => open(it)), remove);
        const from = el('p', 'launch-rem-from', it.source ? `${it.changed ? 'Changed from' : 'From'} the template: ${it.source}` : 'Added by you in this panel');
        c.append(top, el('p', 'launch-rem-text', it.text), from, acts);
        return c;
    }
    function open(target) {
        if (!target.text && items.length >= MAX_REMINDERS) { say.textContent = FULL; return; }
        editing = target; formHost.replaceChildren(); say.textContent = '';
        const form = el('form', 'chief-check-form launch-rem-form'); form.noValidate = false;
        form.append(el('h4', '', target.text ? 'Edit reminder' : 'New reminder'));
        const field = (label, input) => { const wrap = el('label', 'chief-check-field', label); wrap.append(input); form.append(wrap); return input; };
        const text = el('textarea'); text.rows = 3; text.maxLength = 1000; text.required = true; text.value = target.text || ''; field('Instruction', text);
        const kind = el('select'); for (const [v, t] of KINDS) kind.append(Object.assign(el('option', '', t), { value: v })); kind.value = target.kind || 'daily'; field('Schedule', kind);
        const every = el('select'); for (const [v, t] of INTERVALS) every.append(Object.assign(el('option', '', t), { value: String(v) })); every.value = String(target.every_minutes || 15); field('Repeat every', every);
        const [d0, t0] = target.kind === 'weekly' ? String(target.at || '').split(' ') : ['Mon', target.kind === 'once' ? '' : target.at || ''];
        const day = el('select'); for (const [v, t] of DAYS) day.append(Object.assign(el('option', '', t), { value: v })); day.value = d0 || 'Mon'; field('Day', day);
        const when = el('input'); const whenLabel = field('Time', when).parentElement;
        let wasOnce = null;
        const sync = () => {
            const k = kind.value, isOnce = k === 'once'; every.parentElement.hidden = k !== 'every'; day.parentElement.hidden = k !== 'weekly'; whenLabel.hidden = k === 'every';
            when.type = isOnce ? 'datetime-local' : 'time'; whenLabel.firstChild.textContent = isOnce ? 'Date and time' : 'Time';
            if (isOnce !== wasOnce) when.value = wasOnce === null ? (target.kind === 'once' ? String(target.at || '').slice(0, 16) : (t0 || '').slice(0, 5)) : ''; // a time and a date are not the same value: switching between them starts empty
            wasOnce = isOnce;
        };
        kind.addEventListener('change', sync); sync();
        form.append(el('p', 'chief-check-hint', `Times are in ${zone()}, this computer's. The reminder wakes ${who()} and stays open until it marks it done.`));
        const error = el('p', 'chief-check-error'); error.setAttribute('role', 'alert'); error.hidden = true;
        const acts = el('div', 'chief-check-actions'), save = el('button', 'btn btn-primary', 'Save reminder'); save.type = 'submit';
        acts.append(save, button('Cancel', () => close())); form.append(error, acts);
        form.addEventListener('submit', ev => {
            ev.preventDefault(); if (!form.reportValidity()) return;
            const k = kind.value, body = { text: text.value.trim(), kind: k };
            if (!body.text) { error.hidden = false; error.textContent = 'Say what to remind it of.'; return; }
            if (k === 'every') body.every_minutes = Number(every.value);
            else { if (!when.value) { error.hidden = false; error.textContent = 'Choose when.'; return; } body.at = (k === 'weekly' ? `${day.value} ` : '') + when.value.slice(0, 16); }
            if (target.text) { Object.assign(target, body, { changed: !!target.source }); if (k !== 'every') delete target.every_minutes; else delete target.at; } else items.push(body);
            say.textContent = target.text ? 'Reminder saved.' : 'Reminder added.'; close();
        });
        formHost.append(form); draw(); text.focus();
    }
    function close() { editing = null; formHost.replaceChildren(); changed(); }
    draw();
    return {
        drafts: () => items.map(({ text, kind, at, every_minutes, timezone, no_wake }) => ({ text, kind, at, every_minutes, timezone, no_wake })),
        /** A template or persona's reminders: they replace the ones an earlier pick brought and keep the person's own. */
        setSource(name, list = []) {
            const own = items.filter(x => !x.source), from = (list || []).filter(r => r && r.text).map(r => ({ text: r.text, kind: r.kind, at: r.at, every_minutes: r.every_minutes, timezone: r.timezone, no_wake: r.no_wake, source: name }));
            items = [...from, ...own].slice(0, MAX_REMINDERS); changed();
            if (from.length + own.length > MAX_REMINDERS) say.textContent = FULL;
        },
        reset() { items = []; editing = null; formHost.replaceChildren(); say.textContent = ''; changed(); },
    };
}
