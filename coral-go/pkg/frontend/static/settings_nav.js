/* The Settings dialog's groups: a vertical tab list on the left (a selector at the top when the dialog is narrow), one pane per
 * group, and the explanation under each label behind an (i) button (#4566). The panes are in the dialog's template and every
 * control keeps its id, so the code that fills and saves Settings reads the same elements whichever pane is shown.
 *
 *   showSettingsGroup(id)   open the dialog's pane for a group (general, agents, terminal, notifications, files, cleanup, network, security)
 *
 * No imports from modals.js: the dialog module imports this one. */
import { browserLocal } from './safe_storage.js';
import { storeKey } from './local_store.js';
import { onBuilt } from './lazy_dom.js';
import { updatesUiOn } from './update_flag.js';

const GROUP_KEY = 'coral-settings-group';
const FIRST = 'general';
let infoSeq = 0;

const modalEl = () => document.getElementById('settings-modal');
const panes = () => [...(modalEl()?.querySelectorAll('.settings-pane') || [])];
/** Panes with something to show: Coral Hub's dashboard hides every row a hub user cannot change, and a group with none is left out. */
const shown = () => panes().filter(p => !p.dataset.empty);

function tabFor(id) { return document.getElementById(`settings-tab-${id}`); }

/** On a phone (a narrow dialog) Settings is two screens (Beta Tester's phone pass, #10000): the sections, listed, and one section with a way back. The dialog says which one it is on; a wide dialog ignores it. */
const setScreen = screen => modalEl()?.setAttribute('data-screen', screen);

/** Opens the pane for a group; an unknown or empty group opens the first one. Returns the group shown. */
function showSettingsGroup(id, { focus = false, remember = true } = {}) {
    const list = shown();
    const pane = list.find(p => p.dataset.group === id) || list[0];
    if (!pane) return null;
    for (const p of panes()) {
        const on = p === pane;
        p.hidden = !on;
        const tab = tabFor(p.dataset.group);
        if (tab) { tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; if (on) tab.setAttribute('data-initial-focus', ''); else tab.removeAttribute('data-initial-focus'); }
    }
    const pick = document.getElementById('settings-group-select');
    if (pick) pick.value = pane.dataset.group;
    pane.parentElement.scrollTop = 0;
    if (remember) browserLocal.set(storeKey(GROUP_KEY), pane.dataset.group);
    if (focus) tabFor(pane.dataset.group)?.focus();
    document.dispatchEvent(new CustomEvent('coral-settings-group', { detail: { id: pane.dataset.group } })); // the Updates pane draws itself when it is shown (#5275)
    return pane.dataset.group;
}

/** The group Settings opens on: the one last used in this browser. */
export function openSettingsGroup(id) {
    setScreen(id ? 'pane' : 'sections'); // asked for a section: that section; otherwise a phone starts at the list of sections
    return showSettingsGroup(id || browserLocal.get(storeKey(GROUP_KEY)) || FIRST, { remember: false });
}

/** Called after a hub dashboard has hidden the rows it does not allow: a group with no row left leaves the rail. */
export function refreshSettingsGroups() {
    for (const p of panes()) {
        const empty = !p.querySelector('.settings-row:not([hidden]), .sv-row:not([hidden])');
        if (empty) p.dataset.empty = '1'; else delete p.dataset.empty;
        const tab = tabFor(p.dataset.group);
        if (tab) tab.hidden = empty;
    }
    const pick = document.getElementById('settings-group-select');
    if (pick) for (const o of pick.options) o.hidden = !!panes().find(p => p.dataset.group === o.value)?.dataset.empty;
    const cur = panes().find(p => !p.hidden);
    if (!cur || cur.dataset.empty) showSettingsGroup(FIRST, { remember: false });
}

/** The explanation of a row is its hint line, under the label, always visible (#7405: the (i) tooltips are gone): one short line, about ten words. A longer one is not shown; the row has a "Learn more" link that opens it in place (UI/UX's rule). */
const LONG_HINT = 60; // characters: about ten words
// A row whose label alone does not say what it does keeps one short line beside its Learn more (UI/UX's #7405 round 1: Default thinking, Default models, Fit pane width, Free space, Automatic cleanup); a row whose label says it needs no line. By the row's label.
const SHORT_HINTS = {
    'Default thinking': 'How much Claude thinks before it answers.',
    'Default models': 'Used when an agent starts with no model of its own.',
    'Fit pane width': 'Sizes the terminal to this window (tmux).',
    'Artifact store limit': "Above it, agents' new uploads are refused.",
    'Received files limit': 'Above it, new received files are refused.',
    'Desktop alerts': 'Alert while this tab is in the background.',
    'Remote access': 'Let other devices on your network use Coral.',
    'Free space': 'Shrink or prune old saved diffs and artifacts.',
    'Automatic cleanup': 'Prunes what is older than this, every hour. 0 is off.',
};
function buildInfoButtons(root) {
    for (const row of root.querySelectorAll('.settings-row, .net-group')) {
        const group = row.classList.contains('net-group'); // a Network group: its title is the heading its aria-labelledby names (#8491)
        const dt = group ? document.getElementById(row.getAttribute('aria-labelledby')) : row.querySelector(':scope > dt');
        const texts = [...row.querySelectorAll('dt .toggle-desc, [data-info]')];
        if (!dt || !texts.length || row.dataset.hinted) continue;
        row.dataset.hinted = '1';
        const label = dt.querySelector('label, [id$="-label"]') || dt; // a label span that names its control counts too (Default permission mode)
        const name = (label.textContent || '').trim();
        let holder = dt; // a Network group: its hints go in a line of their own at the top of its body
        if (group) {
            holder = document.createElement('div'); holder.className = 'settings-hint-wrap';
            const lead = row.dataset.learnAfter && row.querySelector(row.dataset.learnAfter); // a group whose short line is in its body (Coral Hub's status, Manage's line): Learn more comes after that line, not before it (#7626, UI/UX)
            const anchor = lead && lead.closest('.net-body > *');
            if (anchor) anchor.after(holder); else row.prepend(holder);
        }
        const all = [];
        for (const t of texts) {
            t.removeAttribute('data-info');
            if (!t.classList.contains('settings-hint') && !t.classList.contains('toggle-desc')) t.classList.add('settings-hint');
            t.classList.add('settings-hint-line');
            if (holder !== dt || (t.parentElement !== dt && !dt.contains(t))) holder.append(t); // under the label, where the eye is, not under the control
            all.push(t);
        }
        const long = all.filter(t => (t.textContent || '').trim().length > LONG_HINT);
        if (!long.length) continue;
        for (const t of long) t.classList.add('settings-hint-clamp');
        if (!long[0].id) long[0].id = `settings-hint-${++infoSeq}`;
        if (SHORT_HINTS[name] && !all.some(t => !long.includes(t))) { const line = document.createElement('span'); line.className = 'settings-hint settings-hint-line settings-hint-short'; line.textContent = SHORT_HINTS[name]; holder.append(line); }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'settings-learn';
        btn.textContent = 'Learn more';
        btn.setAttribute('aria-expanded', 'false');
        btn.setAttribute('aria-controls', long.map((t, i) => t.id || (t.id = `${long[0].id}-${i}`)).join(' '));
        btn.setAttribute('aria-label', `Learn more about ${name}`);
        btn.addEventListener('click', () => { const open = btn.getAttribute('aria-expanded') !== 'true'; for (const t of long) t.classList.toggle('settings-hint-clamp', !open); btn.setAttribute('aria-expanded', String(open)); btn.textContent = open ? 'Show less' : 'Learn more'; });
        const lead = row.dataset.learnAfter && row.querySelector(row.dataset.learnAfter);
        if (lead && holder !== dt && lead.parentElement && lead.parentElement.matches('.net-body > *')) lead.after(' ', btn); // the sentence's own line: Learn more follows it on that line (#8276), the long text stays under it
        else holder.append(btn);
    }
}

/** The Hub rows nested in the Coral Hub row (Hub access, the switches under it): their explanation is a visible hint line under the label too, with "Learn more" when it is long (#7405). */
function buildCloudInfoButtons(root) {
    const rows = [
        ...[...root.querySelectorAll('.settings-cloud-switch-row')].map(r => ({ row: r, label: r.querySelector('.settings-cloud-switch-label'), texts: [r.querySelector('.settings-cloud-switch-text > .settings-hint')] })),
        ...[...root.querySelectorAll('.settings-cloud-mode')].map(r => ({ row: r, label: r.querySelector(':scope > label'), texts: [r.querySelector('[data-cloud="mode-full"]')] })),
    ];
    for (const { row, label, texts } of rows) {
        const list = texts.filter(Boolean);
        if (!label || !list.length || row.dataset.hinted) continue;
        row.dataset.hinted = '1';
        for (const t of list) { t.classList.add('settings-hint-line'); t.hidden = false; }
        const long = list.filter(t => (t.textContent || '').trim().length > LONG_HINT);
        if (!long.length) continue;
        for (const t of long) { t.classList.add('settings-hint-clamp'); if (!t.id) t.id = `settings-hint-${++infoSeq}`; }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'settings-learn';
        btn.textContent = 'Learn more';
        btn.setAttribute('aria-expanded', 'false');
        btn.setAttribute('aria-controls', long.map(t => t.id).join(' '));
        btn.setAttribute('aria-label', `Learn more about ${(label.textContent || '').trim()}`);
        btn.addEventListener('click', () => { const open = btn.getAttribute('aria-expanded') !== 'true'; for (const t of long) t.classList.toggle('settings-hint-clamp', !open); btn.setAttribute('aria-expanded', String(open)); btn.textContent = open ? 'Show less' : 'Learn more'; });
        long[long.length - 1].after(btn);
    }
}

function buildTabs(modal) {
    const tabs = modal.querySelector('#settings-tabs');
    const pick = modal.querySelector('#settings-group-select');
    if (!tabs || tabs.childElementCount) return;
    for (const p of panes()) {
        const id = p.dataset.group;
        const b = document.createElement('button');
        b.type = 'button'; b.id = `settings-tab-${id}`; b.className = 'settings-tab'; b.setAttribute('role', 'tab');
        b.setAttribute('aria-controls', p.id); b.setAttribute('aria-selected', String(!p.hidden)); b.tabIndex = p.hidden ? -1 : 0;
        b.innerHTML = `<span class="material-icons" aria-hidden="true">${p.dataset.icon}</span><span class="settings-tab-name"></span>`;
        b.querySelector('.settings-tab-name').textContent = p.dataset.title;
        b.addEventListener('click', () => { showSettingsGroup(id); setScreen('pane'); });
        tabs.append(b);
        const o = document.createElement('option'); o.value = id; o.textContent = p.dataset.title; pick?.append(o);
    }
    const panesEl = modal.querySelector('.settings-panes');
    if (panesEl && !panesEl.querySelector('.settings-back')) { // a phone's way from a section back to the list of sections
        const back = document.createElement('button');
        back.type = 'button'; back.className = 'settings-back btn btn-quiet';
        back.innerHTML = '<span class="material-icons" aria-hidden="true">arrow_back</span><span>Settings</span>';
        back.addEventListener('click', () => { setScreen('sections'); const cur = panes().find(p => !p.hidden); tabFor(cur?.dataset.group)?.focus(); });
        panesEl.prepend(back);
    }
    tabs.addEventListener('keydown', e => {
        const list = [...tabs.querySelectorAll('[role="tab"]:not([hidden])')];
        const i = list.indexOf(document.activeElement);
        if (i < 0) return;
        const to = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: list.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        showSettingsGroup(list[(to + list.length) % list.length].id.replace('settings-tab-', ''), { focus: true });
    });
    pick?.addEventListener('change', () => { showSettingsGroup(pick.value); setScreen('pane'); }); // not drawn on a phone any more (the list of sections replaced it); still a way to switch for anything that drives it
}

onBuilt('settings-modal', modal => {
    if (!updatesUiOn()) modal.querySelectorAll('[data-flag="updates"]').forEach(e => e.remove()); // behind the flag: no tab, no pane (#5275)
    buildTabs(modal); buildInfoButtons(modal); buildCloudInfoButtons(modal);
});
