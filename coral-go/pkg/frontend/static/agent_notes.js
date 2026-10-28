/* Agent notes: every note the agent (or the person) posted, newest first, each with its time; a note opens for editing on a click or Enter and saves when the editor loses focus.
 * The API takes many notes (POST /api/sessions/live/{name}/notes adds one, PATCH changes one, DELETE removes one); this tab used to show only the first (#7653). */

import { state } from './state.js';
import { showToast, sanitizeMarkdown } from './utils.js';
import { serverFetch, serverForSession } from './server_base.js';
import { whenText } from './when_text.js';
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
    const ok = !Number.isNaN(d.getTime());
    const u = new Date(note.updated_at);
    const edited = ok && !Number.isNaN(u.getTime()) && u - d >= 2000;
    // The page's one way of saying when ("2 min ago", "today 2:32 PM"), the exact time as the title (#7653).
    return { text: ok ? `${whenText(note.created_at)}${edited ? ' · edited' : ''}` : 'Note', title: ok ? d.toLocaleString() : '' };
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
    const add = el('button', _notes.length ? 'btn btn-small note-add-small' : 'note-add', _notes.length ? 'Add a note' : 'Add notes'); // with a note on the page, the normal small button
    add.type = 'button'; add.setAttribute('aria-label', 'Add a note');
    add.addEventListener('click', () => startEdit('new'));
    if (!_notes.length) items.push(el('p', 'empty-state-line', 'Private notes for you about this chat.'));
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

/** The edit box is as tall as its text (at least about eight lines, at most most of the list's height, then it scrolls), so a long note is not read through a three-line slot (#7760). */
function growEditor(editor) {
    const list = document.getElementById('note-md-rendered');
    editor.style.height = 'auto';
    const cap = Math.max(160, Math.round(((list && list.clientHeight) || 480) * 0.8));
    editor.style.height = Math.min(editor.scrollHeight + 2, cap) + 'px';
}

/** Save and Cancel under the box, inside the card. They keep the focus where it is on a press (the box saves when it loses the focus), and Tab from the box reaches them (blur ignores the card's own controls). */
function editActions() {
    const bar = el('div', 'note-edit-actions');
    const save = el('button', 'btn btn-small btn-primary', 'Save'), cancel = el('button', 'btn btn-small', 'Cancel');
    save.type = 'button'; cancel.type = 'button';
    for (const b of [save, cancel]) b.addEventListener('mousedown', (e) => e.preventDefault());
    save.addEventListener('click', () => finishEdit());
    cancel.addEventListener('click', () => cancelEdit());
    bar.append(cancel, save);
    return bar;
}

function startEdit(id) {
    if (_editing) return;
    const list = document.getElementById('note-md-rendered');
    const editor = document.getElementById('note-md-editor');
    if (!list || !editor) return;
    _editing = { id };
    let content = '';
    const bar = editActions();
    if (id === 'new') { // a note not written yet is a card too, under its own header
        const card = el('div', 'note-card note-card-editing');
        card.append(el('div', 'note-card-time', 'New note'), editor, bar);
        list.prepend(card);
    } else {
        const card = list.querySelector(`.note-card[data-note-id="${CSS.escape(String(id))}"]`);
        content = (_notes.find(n => String(n.id) === String(id)) || {}).content || '';
        const body = card && card.querySelector('.note-card-body');
        if (body) { body.style.display = 'none'; body.after(editor); editor.after(bar); card.classList.add('note-card-editing'); } else { list.append(editor); editor.after(bar); }
    }
    editor.style.display = '';
    editor.value = content;
    growEditor(editor);
    editor.focus();
    bar.scrollIntoView({ block: 'nearest' }); // Save and Cancel are on the screen with the box, not below the list's edge
}

/** The box is put away, not removed: it is the one shared element that the next edit moves into its card. */
function hideEditor(editor) { if (editor) editor.style.display = 'none'; }

/** Cancel: leave the box without saving what was typed. */
function cancelEdit() {
    if (!_editing) return;
    _editing = null;
    hideEditor(document.getElementById('note-md-editor'));
    renderNotes();
}

async function finishEdit() {
    if (!_editing) return;
    const { id } = _editing;
    const editor = document.getElementById('note-md-editor');
    const content = editor ? editor.value : '';
    const was = id === 'new' ? '' : ((_notes.find(n => String(n.id) === String(id)) || {}).content || '');
    _editing = null;
    hideEditor(editor);
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
    editor.addEventListener('blur', (e) => { if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.note-edit-actions')) return; finishEdit(); }); // Tab to Save or Cancel keeps the box open
    editor.addEventListener('input', () => growEditor(editor));
    window.addEventListener('resize', () => { if (_editing) growEditor(editor); });
    editor.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            editor.blur();
        }
    });
}
