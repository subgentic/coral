/* The phone's mirrored search row, loaded only on a phone (#15859).
 * Input and Enter still go to the view's original search handler. */
import { isPhoneBar } from './phone_layout.js';
const SEARCH_OF = { 'hub-inbox': 'inbox-search', history: 'history-search', automations: 'automations-search', tokens: 'analytics-search', docs: 'docs-search', skills: 'skills-search' };
/** The open Inbox page's own search box (Needs you, Tasks, Goals, Saved, Chats, Files: the page's toolbar draws it in #group-table-view): on a phone the pill is that field and the box is not drawn (#13591). */
const pageSearch = () => { const v = document.getElementById('group-table-view'); if (!v || !/^hub-inbox/.test(v.dataset.group || '') || v.style.display === 'none' || !v.getClientRects().length) return null; const q = [...v.querySelectorAll('.list-bar-search')].find(e => e.closest('.list-bar-search-wrap')); return q || null; };
const searchTarget = () => { const arg = document.querySelector('.top-nav-tab.active')?.dataset.arg || ''; if (arg === 'hub-inbox') { const q = pageSearch(); if (q) return q; } const id = SEARCH_OF[arg], e = id ? document.getElementById(id) : null; return e && !e.closest('[hidden]') ? e : null; }; // a search box the view hides (the page has its own) is not one the bar mirrors (#11859)
export function paintPhoneSearch(words) {
    for (const bar of document.querySelectorAll('.phone-bar')) {
        if (bar.closest('#mobile-agent-list')) continue;
        const target = searchTarget();
        let input = bar.querySelector(':scope > .phone-bar-search');
        for (const w of document.querySelectorAll('.list-bar-search-wrap.phone-searched')) if (!target || target.closest('.list-bar-search-wrap') !== w) w.classList.remove('phone-searched'); // the page box the pill stands in for is not drawn
        if (target?.classList.contains('list-bar-search') && isPhoneBar()) target.closest('.list-bar-search-wrap').classList.add('phone-searched');
        if (!target) { input?.remove(); continue; }
        if (!input) {
            input = document.createElement('input'); input.type = 'search'; input.className = 'field phone-bar-search'; input.autocomplete = 'off'; input.enterKeyHint = 'search';
            input.addEventListener('input', () => { const to = searchTarget(); if (to && to.value !== input.value) { to.value = input.value; to.dispatchEvent(new Event('input', { bubbles: true })); } });
            input.addEventListener('keydown', e => { if (e.key !== 'Enter') return; const to = searchTarget(); if (!to || !to.classList.contains('list-bar-search')) return; e.preventDefault(); to.value = input.value; to.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: e.repeat, bubbles: true, cancelable: true })); }); // a page whose search is a request to another computer sends it on Enter (the Hub's commitOnEnter)
            bar.append(input);
        }
        const own = target.classList.contains('list-bar-search') ? (target.getAttribute('aria-label') || '').trim() : ''; // the page's own words: "Search needs you", "Search tasks"
        const label = own || `Search ${words}`; // what the field says; its name adds where it is, so it never shares one with the sidebar's own search (two controls, one name: the census, QA #11476)
        if (input.placeholder !== label) { input.placeholder = label; input.setAttribute('aria-label', `${label} from the top bar`); }
        if (input._for !== target.id) { input._for = target.id; input.value = target.value; } // another view's search: its own words, even while the field has the focus
        else if (document.activeElement !== input && input.value !== target.value) input.value = target.value; // the view's own search words, kept when the tab is left and come back to
    }
}
