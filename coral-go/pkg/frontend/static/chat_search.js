import { historyFetch, historyServer } from './history_source.js';
import { identityKey } from './server_base.js';
import { filterState } from './search_filters.js';
import { escapeHtml } from './utils.js';
import { historyLabel } from './history_label.js';
import { importOnce } from './import_once.js';

let requestGeneration = 0;

// The search endpoint uses complete/partial/unavailable. Keep this check
// shared and explicit so a successful response is never rendered as an error.
export function isSearchResponseUsable(status) {
    return status === 'complete' || status === 'partial';
}

function utf16Slice(text, start, end) {
    const chars = Array.from(String(text));
    let units = 0, out = '';
    for (const ch of chars) {
        const next = units + ch.length;
        if (next > start && units < end) out += ch;
        units = next;
        if (units >= end) break;
    }
    return out;
}

// An excerpt is raw transcript text: its markdown marks (** ~~ backticks, a heading's #, and __ around words) are dropped and the offsets, which count the raw text, are moved onto the words that stay (#17801).
// A double underscore is emphasis only around words: snake__case and __init__ keep theirs (#17912).
const MD_MARKS = /\*\*|~~|`+|^#{1,6}[ \t]+/gm, UNDER = /(?<!\w)__(?=[^\s_])((?:[^_\n]|_(?!_))*?[^\s_])__(?!\w)/g;
function plainWords(raw, offsets) {
    const marks = [...raw.matchAll(MD_MARKS)].map(m => [m.index, m.index + m[0].length]);
    for (const m of raw.matchAll(UNDER)) if (/\s/.test(m[1])) marks.push([m.index, m.index + 2], [m.index + m[0].length - 2, m.index + m[0].length]);
    marks.sort((a, b) => a[0] - b[0]);
    let out = '', last = 0;
    const at = new Array(raw.length + 1);
    const keep = to => { for (; last < to; last++) { at[last] = out.length; out += raw[last]; } };
    for (const [from, to] of marks) { keep(from); for (; last < to; last++) at[last] = out.length; }
    keep(raw.length); at[raw.length] = out.length;
    const to = n => at[Math.min(Math.max(0, n), raw.length)];
    return { text: out, offsets: offsets.map(r => Array.isArray(r) && r.length >= 2 ? [to(Number(r[0]) || 0), to(Number(r[1]) || 0)] : r) };
}

export function highlightExcerpt(text, rawOffsets = []) {
    const { text: source, offsets } = plainWords(String(text || ''), rawOffsets);
    const ranges = offsets.filter(r => Array.isArray(r) && r.length >= 2)
        .map(r => [Math.max(0, Number(r[0]) || 0), Math.max(0, Number(r[1]) || 0)])
        .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
    if (!ranges.length) return escapeHtml(source);
    let html = '', cursor = 0;
    for (const [start, end] of ranges) {
        const a = Math.max(cursor, start), b = Math.max(a, end);
        if (a > cursor) html += escapeHtml(utf16Slice(source, cursor, a));
        html += `<mark>${escapeHtml(utf16Slice(source, a, b))}</mark>`;
        cursor = b;
    }
    return html + escapeHtml(utf16Slice(source, cursor, Number.MAX_SAFE_INTEGER));
}

// A result is named for its chat the way the list names it (its title, else the start of its first reply), never by the session's id; a chat that is not in the loaded list is a plain "Chat".
function resultLabel(result) {
    if (result.type === 'group') return result.project || result.session_id || 'Board';
    const row = (known.rows || []).find(s => s.session_id === result.session_id);
    return row ? historyLabel(row) : 'Chat';
}

// The loaded chats and the time format, brought in when a search draws (not at load: this file's pure helpers are used on their own too).
const known = { rows: [], time: ts => '' };

const WHO = { user: 'You', assistant: 'Agent' };
const when = ts => { if (!ts) return ''; const d = new Date(ts); return Number.isNaN(d.getTime()) ? '' : known.time(ts); };
const dot = parts => parts.filter(Boolean).join(' · ');

function renderResult(result, index) {
    const hits = Array.isArray(result.hits) ? result.hits : [];
    const wrapper = document.createElement('section');
    wrapper.className = 'chat-search-result';
    wrapper.setAttribute('aria-labelledby', `chat-search-result-${index}`);
    wrapper.innerHTML = `<div class="chat-search-result-header"><strong id="chat-search-result-${Number(index)}">${escapeHtml(resultLabel(result))}</strong><span>${escapeHtml(dot([result.type === 'group' ? 'Group chat' : result.source_type, when(result.last_timestamp)]))}</span></div>`;
    for (const hit of hits) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'chat-search-hit';
        button.dataset.sessionId = hit.locator?.session_id || result.session_id || '';
        button.dataset.project = hit.locator?.project || result.project || '';
        button.innerHTML = `<span class="chat-search-hit-meta">${escapeHtml(dot([WHO[hit.role] || hit.role || 'Message', when(hit.timestamp)]))}</span> <span class="chat-search-hit-excerpt">${highlightExcerpt(hit.excerpt, hit.match_offsets)}</span>`;
        button.addEventListener('click', () => openSearchHit(result, hit));
        button.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); button.click(); }
        });
        wrapper.appendChild(button);
    }
    return wrapper;
}

async function openSearchHit(result, hit) {
    const locator = hit.locator || {};
    if (result.type === 'group' || locator.project) {
        if (window.selectBoardProject) window.selectBoardProject(identityKey(historyServer(), locator.project || result.project), locator.message_id);
        return;
    }
    if (locator.session_id && window.selectHistorySession) {
        await window.selectHistorySession(locator.session_id, locator);
    }
}

/** Opens a chat a search found at the message that matches (the locator of its first hit), or at the newest when the search names none (#17801). */
export async function openAtMatch(query, chat) {
    let at = null;
    try {
        const response = await historyFetch(`/api/sessions/history/search?${new URLSearchParams({ q: String(query || '').trim(), page: '1', page_size: '20', type: 'all', session_id: chat.session_id })}`);
        if (response.ok) at = (await response.json()).results?.find(r => r.session_id === chat.session_id)?.hits?.[0]?.locator || null;
    } catch { /* the chat still opens, at the newest */ }
    return window.selectHistorySession?.(chat.session_id, at, chat);
}

// What a screen reader hears: one short line (the results list is not a live region, so a list is not read out whole on every keystroke).
function say(text) { const el = document.getElementById('chat-search-status'); if (el) el.textContent = text; }

// The Chats page's table lists the chats the search found (history_list.js), asked lazily: this file's pure helpers are used on their own too.
function publishMatches(ids) { importOnce('./history_list.js').then(m => m.setChatSearchMatches(ids)).catch(() => {}); }

export async function searchChats(query, page = 1) {
    const container = document.getElementById('chat-search-results');
    const list = document.getElementById('history-sessions-list');
    if (!container || !list) return;
    const q = String(query || '').trim();
    const generation = ++requestGeneration;
    const source = historyServer();
    if (!q) { container.hidden = true; container.replaceChildren(); list.hidden = false; say(''); publishMatches(null); return; }
    container.hidden = false; list.hidden = true;
    container.replaceChildren(Object.assign(document.createElement('div'), { className: 'loading-indicator', textContent: 'Searching chats…' }));
    try {
        const params = new URLSearchParams({ q, page: String(page), page_size: '20', type: filterState.chatType || 'all' });
        const response = await historyFetch(`/api/sessions/history/search?${params}`);
        if (!response.ok) throw new Error(`Search failed (${response.status})`);
        const data = await response.json();
        if (generation !== requestGeneration || source !== historyServer()) return;
        try { const { state } = await importOnce('./state.js'); known.rows = state.historySessionsList || []; known.time = formatShortTime; } catch { known.rows = []; known.time = () => ''; } // names and times are a nicety: a search still lists its hits without them
        if (generation !== requestGeneration || source !== historyServer()) return; // a newer search began while the helpers loaded
        container.replaceChildren();
        if (data.status && !isSearchResponseUsable(data.status)) {
            container.textContent = 'Search is temporarily unavailable.'; say(container.textContent);
            return;
        }
        if (!data.results?.length) { container.textContent = 'No matching chats.'; say('No matching chats.'); publishMatches([]); return; }
        if (data.status === 'partial') {
            const note = document.createElement('div'); note.className = 'chat-search-status';
            note.textContent = 'Some chat sources are unavailable.'; container.appendChild(note);
        }
        data.results.forEach((result, i) => container.appendChild(renderResult(result, i)));
        publishMatches(data.results.map(r => r.type === 'group' ? 'board:' + (r.project || '') : r.session_id));
        const n = data.results.length;
        say(`${n} ${n === 1 ? 'chat matches' : 'chats match'}.${data.status === 'partial' ? ' Some chat sources are unavailable.' : ''}`);
    } catch (error) {
        if (error.name === 'AbortError' || generation !== requestGeneration || source !== historyServer()) return;
        container.textContent = error.message || 'Search failed.'; say(container.textContent);
    }
}

function formatShortTime(isoStr) {
    const d = new Date(isoStr);
    if (isNaN(d)) return "";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd}/${mm}/${yy}`;
}
