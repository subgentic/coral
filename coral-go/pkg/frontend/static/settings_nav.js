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
import { settingsDocsLink } from './docs_answer.js';

const GROUP_KEY = 'coral-settings-group';
const FIRST = 'general';

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
    const backName = document.querySelector('#settings-modal .settings-back span:last-child'); if (backName) { backName.textContent = pane.dataset.title || 'Settings'; backName.parentElement.setAttribute('aria-label', 'Back to Settings'); } // a phone's section bar: the arrow and the section's name (its own title is not drawn twice)
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

/** Legacy Network rows share the same help line and Docs anchor as schema rows. */
const HINTS = {
    'Coral Hub': 'Limit what Coral Hub can do on this computer.',
    'Let Coral Hub relaunch this Coral to install updates': 'Allow Coral Hub to install a version already downloaded and checked here.',
    'Coral Hub can turn on auto-accept': 'Allow Coral Hub to enable automatic permission approval.',
    'Let Coral Hub change cross-team settings': 'Allow Coral Hub to change how teams communicate.',
    'Hide tokens from view-only hub users': 'Hide secrets from people with view-only access through Coral Hub.',
    'Let Coral Hub act as the Operator': 'Allow Coral Hub users to make Operator decisions here.',
};
function docsHint(holder, name, original = null) {
    const p = original || document.createElement('p'); p.hidden = false; p.classList.add('sv-help', 'settings-hint-line');
    const sentence = document.createElement('span'); sentence.textContent = HINTS[name] || 'Permissions and limits for this computer.';
    if (p.id) { sentence.id = p.id; p.removeAttribute('id'); }
    p.replaceChildren(sentence, ' ');
    const answer = name === 'Coral Hub' ? 'Coral Hub access limits' : HINTS[name] ? name : 'Settings help for Coral Hub access';
    const a = settingsDocsLink({ docs: { topic: 'hub', answer } }, { label: name });
    p.append(a); if (!original) holder.append(p);
}
function buildInfoButtons(root) {
    for (const row of root.querySelectorAll('.settings-row, .net-group')) {
        const dt = row.classList.contains('net-group') ? document.getElementById(row.getAttribute('aria-labelledby')) : row.querySelector(':scope > dt');
        const texts = [...row.querySelectorAll('dt .toggle-desc, [data-info]')];
        if (!dt || !texts.length || row.dataset.hinted) continue;
        row.dataset.hinted = '1';
        for (const t of texts) { t.removeAttribute('data-info'); t.hidden = true; }
        const name = (dt.querySelector('label, [id$="-label"]') || dt).textContent.trim();
        docsHint(row.querySelector('.net-body') || dt, name, texts[0]);
        const lead = row.dataset.learnAfter && row.querySelector(row.dataset.learnAfter);
        lead?.closest('.net-body > *')?.after(texts[0]);
    }
}
function buildCloudInfoButtons(root) {
    for (const row of root.querySelectorAll('.settings-cloud-switch-row, .settings-cloud-mode')) {
        const label = row.querySelector('.settings-cloud-switch-label, :scope > label');
        const text = row.querySelector('.settings-cloud-switch-text > .settings-hint, [data-cloud="mode-full"]');
        if (!label || !text || row.dataset.hinted) continue;
        row.dataset.hinted = '1'; text.hidden = true;
        docsHint(text.parentElement, label.textContent.trim(), text.matches('[data-cloud="mode-full"]') ? null : text);
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
        if (p.dataset.hint) b.querySelector('.settings-tab-name').setAttribute('data-sub', p.dataset.hint); // a phone's list says what is inside (mobile.css): General: Theme... (#11128)
        b.addEventListener('click', () => { showSettingsGroup(id); setScreen('pane'); if (!b.getClientRects().length) p.focus({ preventScroll: true }); }); // on a phone the list goes away: the keyboard is on the section, which the tab names (it was on nothing, #10644)
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

/** Complete hints after lazy field rows have supplied their headings. Idempotent for existing hints. */
export function buildSettingsHints(modal) { buildInfoButtons(modal); buildCloudInfoButtons(modal); }
