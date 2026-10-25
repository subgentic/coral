/* Agent notes: every note the agent (or the person) posted, newest first, each with its time; a note opens for editing on a click or Enter and saves when the editor loses focus.
 * The API takes many notes (POST /api/sessions/live/{name}/notes adds one, PATCH changes one, DELETE removes one); this tab used to show only the first (#7653). */

import { state } from './state.js';
import { showToast, sanitizeMarkdown } from './utils.js';
import { serverFetch, serverForSession } from './server_base.js';
import { currentServer, pathId } from './server_base.js';

let _notes = [];      // { id, content, created_at, updated_at }, newest first (the server's order)
let _editing = null;  // null, or { id } of the note being edited ('new' for one not saved yet)

function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
}

export async function loadAgentNotes(agentName, sessionId, options) {
    if (!agentName) return;
    const sid = sessionId || (state.currentSession && state.currentSession.session_id);
    try {
        const params = new URLSearchParams();
        if (sid) params.set("session_id", sid);
        const qs = params.toString() ? `?${params}` : "";
        const resp = await serverFetch(serverForSession(agentName, sid), `/api/sessions/live/${encodeURIComponent(agentName)}/notes${qs}`, options);
        if (!resp.ok) throw new Error(`notes fetch failed: ${resp.status}`);
        const notes = await resp.json();
        if (sid && state.currentSession?.session_id !== sid) return;
        _notes = Array.isArray(notes) ? notes.filter(n => n && String(n.content || '').trim()) : [];
    } catch (e) {
        if (e?.name === 'AbortError') return;
        if (sid && state.currentSession?.session_id !== sid) return;
        _notes = [];
    }
    renderNotes();
}

function showCount() {
    const countEl = document.getElementById('note-bar-count');
    if (countEl) countEl.textContent = _notes.length ? String(_notes.length) : '';
}

function when(note) {
    const d = new Date(note.created_at);
    const at = Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
    const u = new Date(note.updated_at);
    const edited = !Number.isNaN(u.getTime()) && !Number.isNaN(d.getTime()) && u - d >= 2000;
    return { text: at ? `${at}${edited ? ' · edited' : ''}` : 'Note', title: at };
}

function renderNotes() {
    showCount();
    const list = document.getElementById('note-md-rendered');
    const editor = document.getElementById('note-md-editor');
    if (!list || !editor) return;
    if (_editing) return; // don't clobber while editing
    editor.style.display = 'none';
    if (editor.parentElement !== list.parentElement) list.after(editor);
    const items = [];
    const add = el('button', 'note-add', _notes.length ? 'Add a note' : 'Add notes');
    add.type = 'button'; add.setAttribute('aria-label', 'Add a note');
    add.addEventListener('click', () => startEdit('new'));
    items.push(add);
    for (const note of _notes) {
        const card = el('div', 'note-card'); card.setAttribute('role', 'group');
        card.dataset.noteId = String(note.id);
        const w = when(note);
        const head = el('div', 'note-card-time', w.text); head.title = w.title;
        const body = el('div', 'note-md-rendered note-card-body notes-rendered');
        body.setAttribute('role', 'button'); body.tabIndex = 0; body.setAttribute('aria-label', `Edit the note from ${w.title || 'this agent'}`);
        if (typeof marked !== 'undefined') body.innerHTML = sanitizeMarkdown(note.content || '', undefined, 'board'); else body.textContent = note.content || '';
        body.addEventListener('click', () => startEdit(note.id));
        body.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEdit(note.id); } });
        card.append(head, body);
        items.push(card);
    }
    list.replaceChildren(...items);
}

function startEdit(id) {
    if (_editing) return;
    const list = document.getElementById('note-md-rendered');
    const editor = document.getElementById('note-md-editor');
    if (!list || !editor) return;
    _editing = { id };
    let content = '';
    if (id === 'new') {
        list.prepend(editor);
    } else {
        const card = list.querySelector(`.note-card[data-note-id="${CSS.escape(String(id))}"]`);
        content = (_notes.find(n => String(n.id) === String(id)) || {}).content || '';
        const body = card && card.querySelector('.note-card-body');
        if (body) { body.style.display = 'none'; body.after(editor); } else list.append(editor);
    }
    editor.style.display = '';
    editor.value = content;
    editor.focus();
}

async function finishEdit() {
    if (!_editing) return;
    const { id } = _editing;
    const editor = document.getElementById('note-md-editor');
    const content = editor ? editor.value : '';
    const was = id === 'new' ? '' : ((_notes.find(n => String(n.id) === String(id)) || {}).content || '');
    _editing = null;
    if (editor) editor.style.display = 'none';
    if (content !== was) await saveContent(id, content);
    renderNotes();
}

async function saveContent(id, content) {
    if (!state.currentSession || state.currentSession.type !== 'live') return;
    const agentName = encodeURIComponent(state.currentSession.name);
    const server = currentServer();
    const empty = !content.trim();
    try {
        if (id === 'new') {
            if (empty) return;
            const sid = state.currentSession.session_id;
            const resp = await serverFetch(server, `/api/sessions/live/${encodeURIComponent(agentName)}/notes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content, session_id: sid }),
            });
            const created = await resp.json();
            _notes = [created, ..._notes];
        } else if (empty) { // a note emptied is removed, not kept as a blank card
            await serverFetch(server, `/api/sessions/live/${encodeURIComponent(agentName)}/notes/${pathId(id)}`, { method: 'DELETE' });
            _notes = _notes.filter(n => String(n.id) !== String(id));
        } else {
            await serverFetch(server, `/api/sessions/live/${encodeURIComponent(agentName)}/notes/${pathId(id)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content }),
            });
            _notes = _notes.map(n => String(n.id) === String(id) ? { ...n, content, updated_at: new Date().toISOString() } : n);
        }
    } catch {
        showToast('Failed to save notes', true);
    }
}

export function initNotesMd() {
    const list = document.getElementById('note-md-rendered');
    const editor = document.getElementById('note-md-editor');
    if (!list || !editor) return;
    editor.addEventListener('blur', () => finishEdit());
    editor.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            editor.blur();
        }
    });
}
