/* $skill mention autocomplete for the command input textarea (#12677, the Operator): "$" at the start of a word opens the approved skills, the words after it search them, a pick attaches
 * the skill to this agent and puts the route's line ("Use the skill X (coral-agent skills get --id ...).") in place of "$words". Built on the list /command and @file share (mention_list.js). */

import { state } from './state.js';
import { isDropdownVisible as isFileMentionVisible } from './file_mention.js';
import { createMentionList, findTriggerStart, isMentionListOpen, highlightRuns } from './mention_list.js';
import { serverFetch, serverForSession, isCloud } from './server_base.js';
import { showToast } from './utils.js';
import { go } from './nav.js';

const list = createMentionList({ dropdown: 'skill-mention-dropdown', item: 'skill-mention-item' }, { onInput: e => onInput(e), onPick: i => pick(i), onHide: () => { _asked++; } });
let _asked = 0; // each search is numbered: an answer that is not for the latest words is dropped
let _timer = null;
let _dismissed = -1; // where an Escape closed the menu: it stays closed for that "$" until the text around it changes
const SEARCH_DELAY_MS = 120;

export function initSkillMention() {
    const input = document.getElementById('command-input');
    if (!input) return;
    list.mount(input);
    input.addEventListener('keydown', e => { if (e.key === 'Escape' && list.visible()) _dismissed = list.start; }, true); // before the list's own Escape handler hides it and forgets where it started
}

function onInput(e) {
    if (isFileMentionVisible() || isMentionListOpen('command-mention-dropdown')) return; // one menu at a time
    const input = e.target, before = input.value.slice(0, input.selectionStart);
    const idx = findTriggerStart(before, '$'); // a "$" inside a word (a price, $PATH in a command) is not a mention
    if (idx === -1) { _dismissed = -1; list.hide(); return; }
    if (idx === _dismissed) return; // Escape closed this one
    list.start = idx;
    const words = before.slice(idx + 1);
    clearTimeout(_timer);
    if (isCloud()) { showRows([], words, 'Skills stay on your computer: open this agent from its own Coral to add one.'); return; } // through the Hub there is no skill list to read (#12677)
    const mine = ++_asked;
    _timer = setTimeout(() => search(words, mine, idx), SEARCH_DELAY_MS);
}

async function search(words, mine, idx) {
    const cur = state.currentSession;
    if (!cur || cur.type !== 'live') { list.hide(); return; }
    try {
        const r = await serverFetch(serverForSession(cur.name, cur.session_id), `/api/skills/search?q=${encodeURIComponent(words)}`);
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (mine !== _asked || list.start !== idx) return; // the words moved on, or the menu was closed
        const skills = Array.isArray(j.skills) ? j.skills : [];
        if (skills.length === 0 && words) { list.hide(); return; } // "$PATH": nothing is called that, so there is no menu
        showRows(skills, words, '');
    } catch { if (mine === _asked) list.hide(); }
}

function showRows(skills, words, note) {
    list.results = skills;
    list.selected = 0;
    if (note) { list.results = [{ note }]; list.show([{ cells: [{ cls: 'skill-note', parts: [note] }] }]); return; }
    if (skills.length === 0) { list.results = [{ store: true }]; list.show([{ cells: [{ cls: 'skill-note', parts: ['No approved skills yet. Open the Skills Store'] }] }]); return; }
    list.show(skills.map(s => ({ sep: ' ', cells: [{ cls: 'skill-name', parts: highlight(s.name, words) }, { cls: 'skill-desc', parts: [oneLine(s.description)] }] })));
}

const oneLine = t => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 140);
function highlight(name, words) {
    const q = String(words || '').toLowerCase(), lower = String(name).toLowerCase(), at = q ? lower.indexOf(q) : -1;
    return at < 0 ? [String(name)] : highlightRuns(String(name), new Set([...q].map((_, i) => at + i)));
}

async function pick(index) {
    const input = document.getElementById('command-input'), item = list.results[index];
    if (!input || !item) return;
    if (item.note) return; // the Hub's note is not a skill
    if (item.store) { list.hide(); go({ view: 'skills' }); return; }
    const cur = state.currentSession;
    if (!cur || cur.type !== 'live') return;
    const start = list.start, cursor = input.selectionStart;
    try {
        const r = await serverFetch(serverForSession(cur.name, cur.session_id), `/api/sessions/live/${encodeURIComponent(cur.name)}/skills?session_id=${encodeURIComponent(cur.session_id || '')}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skill_id: item.id }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || typeof j.line !== 'string') throw new Error((j && j.error) || `HTTP ${r.status}`);
        const text = input.value, end = Math.max(cursor, input.selectionStart);
        const at = text.slice(start, start + 1) === '$' ? start : -1; // the text may have moved while the attach was on its way: only the same "$" is replaced
        if (at < 0) { showToast('Skill attached. Its line was not added: the text changed.'); list.hide(); return; }
        input.value = text.slice(0, start) + j.line + ' ' + text.slice(end);
        input.selectionStart = input.selectionEnd = start + j.line.length + 1;
        input.dispatchEvent(new Event('input', { bubbles: true })); // the box grows and the draft is kept
        input.focus();
        list.hide();
    } catch (e) { showToast(`The skill was not attached: ${e && e.message ? e.message : 'try again'}`); }
}
