/* The shortcuts dialog is built only when opened (#17510). */
import { el } from './dom_el.js';
import { shortcutList } from './shortcuts.js';
const SHORTCUT_GROUPS = ['Navigation', 'Chat', 'Search', 'Dialogs'];
const onMac = () => /Mac|iPhone|iPad/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');

// A row's keys as chips: "Cmd+P or Cmd+K" is two alternatives of two keys each. A bare Up or Down after "Option+Down or" is the same modifiers with the other arrow. A Mac shows its glyphs; any other computer the words.
const GLYPH = { Cmd: '⌘', Option: '⌥', Shift: '⇧', Ctrl: '⌃', Down: '↓', Up: '↑', Escape: 'Esc' };
const GLYPH_NAME = { '⌘': 'Command', '⌥': 'Option', '⇧': 'Shift', '⌃': 'Control', '↓': 'Down arrow', '↑': 'Up arrow' }; // a glyph has no name a screen reader says right: the command sign is read as a place of interest
const keyChips = (keys, mac = onMac()) => {
    const alts = [];
    for (const a of keys.split(' or ')) {
        const parts = a === '+' ? [a] : a.split(/\+(?=.)/);
        if (parts.length === 1 && /^(Up|Down)$/.test(parts[0]) && alts.length) parts.unshift(...alts[alts.length - 1].slice(0, -1));
        alts.push(parts);
    }
    return alts.map(parts => parts.map(k => (mac || /^(Down|Up|Escape)$/.test(k)) ? GLYPH[k] || k : k));
};

/** The dialog's body: a heading and a list for each group, a row being the keys (<dt>, one <kbd> chip a key) beside what they do (<dd>). */
function buildShortcuts(mac = onMac()) {
    const frag = document.createDocumentFragment(), rows = [...shortcutList(mac), ['J or K', 'Next or previous Inbox item (while a review is open)', 'Navigation']]; // #21852: named here, in the lazy dialog, so the start bundle does not grow
    for (const group of SHORTCUT_GROUPS) {
        const sec = el('section', 'kbd-group'), h = el('h4', 'group-head', group), dl = el('dl', 'kbd-list');
        for (const [keys, what, g] of rows) {
            if (g !== group) continue;
            const row = el('div', 'kbd-row'), dt = el('dt', 'kbd-keys');
            keyChips(keys, mac).forEach((combo, i) => {
                if (i) dt.append(el('span', 'kbd-or', 'or'));
                const pair = el('span', 'kbd-combo'); // a key and its '+' stay on one line
                combo.forEach((k, n) => {
                    if (n && !mac) pair.append(el('span', 'kbd-plus', '+'));
                    const kbd = el('kbd', 'kbd-key', k);
                    if (GLYPH_NAME[k]) kbd.setAttribute('aria-label', GLYPH_NAME[k]);
                    pair.append(kbd);
                });
                dt.append(pair);
            });
            row.append(dt, el('dd', 'kbd-what', what)); dl.append(row);
        }
        sec.append(h, dl); frag.append(sec);
    }
    return frag;
}

export async function showShortcuts() {
    const m = document.getElementById('shortcuts-modal'), body = document.getElementById('shortcuts-body');
    if (!m || !body) return;
    body.replaceChildren(buildShortcuts());
    const close = document.getElementById('shortcuts-close');
    if (close && !close.dataset.wired) {
        close.dataset.wired = '1';
        close.addEventListener('click', () => { m.style.display = 'none'; }); // display-ok: a dialog is hidden by display none, as modal_chrome.js hides every unlisted one
    }
    m.style.display = 'flex'; // display-ok: a .modal shows as a flex overlay, as showAlertModal does
    body.scrollTop = 0;
    // The list is a Tab stop only while it scrolls: a keyboard user reaches the rows below the fold, and a list that fits (or an empty one) is no stop and no 16 px target (phone_layout)
    const sync = () => { body.tabIndex = body.scrollHeight > body.clientHeight + 1 ? 0 : -1; };
    sync();
    if (!body.dataset.syncWired) { body.dataset.syncWired = '1'; window.addEventListener('resize', sync); }
}

