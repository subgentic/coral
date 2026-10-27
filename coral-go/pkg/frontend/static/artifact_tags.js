/* Artifact tags (#8594, Goal #61, UI/UX's spec 7): the team's words on its stored files ("for review", "internal"). The rules are the server's (internal/board/artifact_tags.go): lowercase letters, digits, spaces and
 * hyphens, 1 to 24 characters, at most 5 on a file. This module draws them: the chips of a row (two, then +N), the editor of the sheet and the preview (a chip with an x each, a "+ Tag" button that opens the
 * starter set, the team's own tags and a box), and the one call that changes them (the Operator's and the team owner's: PUT /api/board/<team>/artifacts/<id>/tags). Tag words are agents' and people's text:
 * everything is built with textContent. Lazy: the Artifacts page, the preview pane and the Inbox import it. */
import { boardFetch } from './server_base.js';
import { importOnce } from './import_once.js';
const { STARTER, MAX_TAGS, MAX_LEN, normalizeTag } = await importOnce('./artifact_tag_rules.js');

const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** Replaces the tags of one stored file; resolves to the tags the server kept, rejects with its words. */
export async function putTags(project, hex, tags) {
    const r = await boardFetch(project, `/artifacts/${hex}/tags`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Coral said ${r.status}`);
    return Array.isArray(d.tags) ? d.tags : tags;
}

export function tagChip(tag) { return mk('span', 'chip artifact-tag', tag); }

/** The tags of a table row: at most two chips, then +N; the whole list in the title. null when there are none. */
export function rowTags(tags) {
    if (!Array.isArray(tags) || !tags.length) return null;
    const wrap = mk('span', 'artifact-tags-row');
    wrap.title = `Tags: ${tags.join(', ')}`;
    for (const t of tags.slice(0, 2)) wrap.append(tagChip(t));
    if (tags.length > 2) wrap.append(mk('span', 'chip chip-count artifact-tag artifact-tag-more', `+${tags.length - 2}`));
    return wrap;
}

/** The accessible name of a row: its file name and its tags. */
export const nameWithTags = (name, tags) => (Array.isArray(tags) && tags.length ? `${name}, tags: ${tags.join(', ')}` : name);

/** The editor of one file's tags. editable false: the chips alone (a Coral Hub viewer reads them, cannot change them).
 *  { project, hex, tags, editable, offer() -> [[tag, count]] (the team's tags), onChange(tags) } -> the element. */
export function tagEditor({ project, hex, tags, editable, offer = () => [], onChange = () => {} }) {
    let current = Array.isArray(tags) ? [...tags] : [];
    const root = mk('div', 'artifact-tags');
    const list = mk('ul', 'artifact-tag-list'); list.setAttribute('aria-label', 'Tags');
    const status = mk('p', 'artifact-tag-status sr-only'); status.setAttribute('role', 'status');
    const add = mk('button', 'artifact-tag-add', '+ Tag'); add.type = 'button'; add.setAttribute('aria-expanded', 'false');
    const box = mk('div', 'artifact-tag-box'); box.hidden = true;
    let busy = false;

    async function change(next, said) {
        if (busy) return;
        busy = true; status.classList.remove('artifact-tag-error');
        try { current = await putTags(project, hex, next); status.textContent = said; onChange([...current]); }
        catch (e) { status.classList.remove('sr-only'); status.classList.add('artifact-tag-error'); status.textContent = `Could not change the tags: ${e.message}`; }
        busy = false; draw();
    }
    const addTag = (raw) => {
        const t = normalizeTag(raw);
        if (!t) { status.classList.remove('sr-only'); status.classList.add('artifact-tag-error'); status.textContent = `A tag is 1 to ${MAX_LEN} letters, digits, spaces or hyphens.`; return; }
        if (current.includes(t)) { box.hidden = true; add.setAttribute('aria-expanded', 'false'); return; }
        box.hidden = true; add.setAttribute('aria-expanded', 'false');
        change([...current, t], `Tag ${t} added`).then(() => add.focus({ preventScroll: true }));
    };

    function drawBox() {
        box.replaceChildren();
        const have = new Set(current);
        const starters = STARTER.filter(t => !have.has(t));
        const team = offer().filter(([t]) => !have.has(t) && !STARTER.includes(t));
        if (starters.length || team.length) {
            const row = mk('div', 'artifact-tag-offers');
            for (const t of starters) { const b = mk('button', 'artifact-tag-offer', t); b.type = 'button'; b.addEventListener('click', () => addTag(t)); row.append(b); }
            for (const [t, n] of team.slice(0, 12)) { const b = mk('button', 'artifact-tag-offer', `${t} (${n})`); b.type = 'button'; b.setAttribute('aria-label', `${t}, on ${n} files`); b.addEventListener('click', () => addTag(t)); row.append(b); }
            box.append(row);
        }
        const form = mk('form', 'artifact-tag-form');
        const input = mk('input', 'artifact-tag-input'); input.type = 'text'; input.maxLength = MAX_LEN; input.setAttribute('aria-label', 'New tag'); input.placeholder = 'Another tag';
        const go = mk('button', 'btn btn-small', 'Add'); go.type = 'submit';
        form.append(input, go);
        form.addEventListener('submit', (e) => { e.preventDefault(); addTag(input.value); });
        box.append(form);
    }

    function draw() {
        list.replaceChildren();
        for (const t of current) {
            const li = mk('li', 'artifact-tag-item');
            li.append(mk('span', 'chip artifact-tag', t));
            if (editable) {
                const x = mk('button', 'artifact-tag-remove'); x.type = 'button'; x.setAttribute('aria-label', `Remove tag ${t}`);
                const icon = mk('span', 'material-icons', 'close'); icon.setAttribute('aria-hidden', 'true'); x.append(icon);
                x.addEventListener('click', () => change(current.filter(c => c !== t), `Tag ${t} removed`).then(() => (list.querySelector('.artifact-tag-remove') || add).focus({ preventScroll: true })));
                li.firstChild.append(x);
            }
            list.append(li);
        }
        add.hidden = !editable || current.length >= MAX_TAGS;
        if (add.hidden) box.hidden = true;
    }
    add.addEventListener('click', () => {
        const open = box.hidden;
        if (open) { drawBox(); } box.hidden = !open; add.setAttribute('aria-expanded', String(open));
        if (open) box.querySelector('.artifact-tag-input')?.focus({ preventScroll: true });
    });
    box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); box.hidden = true; add.setAttribute('aria-expanded', 'false'); add.focus({ preventScroll: true }); } });
    draw();
    root.append(list, add, box, status);
    if (!editable && !current.length) root.hidden = true;
    return root;
}

/** Adds (or takes away) one tag on every one of `hexes`: each file is its own change, the ones that failed are counted. Resolves to { ok: Map(hex -> tags), failed }. */
export async function bulkTag(project, files, word, adding) {
    const ok = new Map(); let failed = 0;
    for (const { hex, tags } of files) {
        const have = Array.isArray(tags) ? tags : [];
        if (adding ? have.includes(word) : !have.includes(word)) { ok.set(hex, have); continue; }
        const next = adding ? [...have, word] : have.filter(t => t !== word);
        if (next.length > MAX_TAGS) { failed++; continue; }
        try { ok.set(hex, await putTags(project, hex, next)); } catch { failed++; }
    }
    return { ok, failed };
}
