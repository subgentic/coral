import { loadStyles } from './lazy_styles.js';
await loadStyles('skill_mention.css');
/* $skill mention autocomplete for the command input textarea (#12677, the Operator): "$" at the start of a word opens the approved skills, the words after it search them, a pick attaches
 * the skill to this agent and puts the route's line ("Use the skill X (coral-agent skills get --id ...).") in place of "$words". Built on the list /command and @file share (mention_list.js). */

import { state } from './state.js';
import { createMentionList, findTriggerStart, highlightRuns } from './mention_list.js';
import { serverFetch, serverForSession, isCloud, LOCAL_SERVER } from './server_base.js';
import { showToast } from './utils.js';
import { go } from './nav.js';
import { importOnce } from './import_once.js';
const { filterSkills } = await importOnce('./skill_filter.js');

const list = createMentionList({ dropdown: 'skill-mention-dropdown', item: 'skill-mention-item' }, { onInput: e => onInput(e), onPick: i => pick(i), onHide: () => { _asked++; _all = null; _loading = false; } });
let _asked = 0; // each read is numbered: an answer for a menu that was closed since is dropped
let _loading = false; // the list of this mention is being read
let _all = null, _words = ''; // the list of this mention (null until it is read) and the words typed after its "$"
let _dismissed = -1, _dismissedFor = ''; // where an Escape closed the menu, and for which agent: it stays closed for that "$" until the text around it changes or another agent is open
const MENU_FULL = 20; // the route lists at most this many (maxMenuSkills)
const SKILLS_STAY = 'Skills stay on the computer: open this agent from its own Coral to add one.';

export function initSkillMention({ dismissed = false } = {}) {
    const input = document.getElementById('command-input');
    if (!input) return;
    list.mount(input);
    input.removeEventListener('keydown', list.onKeydown);
    // Escape closes the menu, and also a mention whose list is still on its way: the answer then opens nothing
    input.addEventListener('keydown', e => { if (e.key === 'Escape' && (list.visible() || _loading)) { _dismissed = list.start; _dismissedFor = agentKey(state.currentSession); if (!list.visible()) list.hide(); }  }, true); // before the list's own Escape handler hides it and forgets where it started
    if (dismissed) { _dismissed = findTriggerStart(input.value.slice(0, input.selectionStart), '$'); _dismissedFor = agentKey(state.currentSession); }
    input.addEventListener('keydown', list.onKeydown, true); // lazy mounting must still choose a skill before the composer handles Enter
}

function onInput(e) {
    const input = e.target, before = input.value.slice(0, input.selectionStart);
    const idx = findTriggerStart(before, '$'); // a "$" inside a word (a price, $PATH in a command) is not a mention
    if (idx === -1) { _dismissed = -1; list.hide(); return; }
    if (idx === _dismissed && _dismissedFor === agentKey(state.currentSession)) return; // Escape closed this one (for this agent)
    list.start = idx;
    _words = before.slice(idx + 1);
    if (isCloud()) { showRows([], _words, SKILLS_STAY); return; } // through the Hub there is no skill list to read (#12677)
    if (_all) draw(); else load(idx);
}

/** The approved skills once per mention (the route lists up to 20): the words filter that list here, as prefixes of the name's parts or of its words, so "$re" finds release-notes at once. The route's own search
 *  is whole words (full-text), so a few letters would find nothing; it is asked only when the list is full (more skills than it shows) and the words match none of it. */
async function load(idx) {
    const cur = state.currentSession;
    if (!cur || cur.type !== 'live') { list.hide(); return; }
    const at = serverForSession(cur.name, cur.session_id), mine = ++_asked;
    _loading = true;
    try {
        const r = await serverFetch(at, '/api/skills/search?q=');
        if (!r.ok) {
            if (at !== LOCAL_SERVER && mine === _asked && list.start === idx) { showRows([], _words, SKILLS_STAY); return; } // another computer's agent and its Hub refuses: one row that says why, not a menu that closes without a word (QA)
            throw new Error(String(r.status));
        }
        const j = await r.json();
        if (mine !== _asked || list.start !== idx) return; // the menu was closed or is another mention
        _all = { at, skills: Array.isArray(j.skills) ? j.skills : [] };
        draw(); // the words as they are NOW: an answer that arrives late is filtered by what was typed since
    } catch { if (mine === _asked) list.hide(); } finally { if (mine === _asked) _loading = false; }
}

function draw() {
    if (!_all) return;
    const skills = filterSkills(_all.skills, _words);
    if (skills.length) { showRows(skills, _words, ''); return; }
    if (!_words) { showRows([], _words, ''); return; } // no approved skills at all: the row that says so
    if (_all.skills.length >= MENU_FULL) { fallback(_words); return; } // more skills than the list shows: the route's own search may know one
    list.hide(); // "$PATH": nothing is called that, so there is no menu
}

async function fallback(words) {
    const cur = state.currentSession, mine = ++_asked, idx = list.start;
    if (!cur || cur.type !== 'live' || !_all) return;
    try {
        const r = await serverFetch(_all.at, `/api/skills/search?q=${encodeURIComponent(words)}`);
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (mine !== _asked || list.start !== idx || _words !== words) return; // the words moved on
        const skills = Array.isArray(j.skills) ? j.skills : [];
        if (skills.length) showRows(skills, words, ''); else list.hide();
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

/** The route names an agent <cli>-<session id>, the one its session_id belongs to (Security's SHOULD on #12676): not the tmux name the rest of the live routes take. Found by the real-server suite (#12766): with the name, every attach was refused. */
const attachName = s => `${s.agent_type || 'claude'}-${s.session_id}`;
let _picking = false; // one pick at a time: a second Enter or tap while an attach is on its way does nothing
const agentKey = s => (s ? `${serverForSession(s.name, s.session_id)}|${s.name || ''}|${s.session_id || ''}` : '');
async function pick(index) {
    const input = document.getElementById('command-input'), item = list.results[index];
    if (!input || !item || _picking) return;
    if (item.note) return; // the Hub's note is not a skill
    if (item.store) { list.hide(); go({ view: 'skills' }); return; }
    const cur = state.currentSession;
    if (!cur || cur.type !== 'live') return;
    // what this pick is for, fixed now (UI Reviewer): the agent, and the exact "$words" token with the text before and after it
    const agent = agentKey(cur), start = list.start, end = input.selectionStart, typed = input.value.slice(start, end);
    if (!typed.startsWith('$')) return;
    _picking = true;
    try {
        const r = await serverFetch(serverForSession(cur.name, cur.session_id), `/api/sessions/live/${encodeURIComponent(attachName(cur))}/skills?session_id=${encodeURIComponent(cur.session_id || '')}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skill_id: item.id }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || typeof j.line !== 'string') throw new Error((j && j.error) || `HTTP ${r.status}`);
        const box = document.getElementById('command-input'); // the box of whichever agent is open now
        const text = box ? box.value : '';
        if (agentKey(state.currentSession) !== agent || !box || text.slice(start, start + typed.length) !== typed) { // another agent, or the "$words" were edited meanwhile: the skill is attached, the text is left as it is
            showToast('The skill was attached. Its line was not added: the message or the agent changed.'); list.hide(); return;
        }
        box.value = text.slice(0, start) + j.line + ' ' + text.slice(start + typed.length); // the text after the token stays whatever the caret did meanwhile
        box.selectionStart = box.selectionEnd = start + j.line.length + 1;
        box.dispatchEvent(new Event('input', { bubbles: true })); // the box grows and the draft is kept
        box.focus();
        list.hide();
    } catch (e) { showToast(`The skill was not attached: ${e && e.message ? e.message : 'try again'}`); }
    finally { _picking = false; }
}

// The first trigger was typed before this module loaded; read the current field, not the old event.
export const refreshSkillMention = input => onInput({ target: input });
