/* The pictures of a comment being written (#11651, goal #184): paste, drop or pick one or more, each shows as a thumbnail before Send and can be removed; each is stored as it is added (POST comment-images), so Send only names
 * what is already stored and the marked-up version of a picture (a second version of the same artifact) has its first version's hex to follow. A phone's picker offers the photos. Everything the person or the server wrote is set as
 * text or as an attribute, never as HTML. The tray is kept by the composing state, so a redraw of the panel gives the same node back with its pictures. */
import { importOnce } from './import_once.js';
const api = await importOnce('./artifact_comments_api.js'); // lazy: its failure is retried
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const MAX_BYTES = 25 * 1024 * 1024; // a larger file is refused here with the reason; the server's own cap is the one that counts
const typeOf = f => String((f && f.type) || '').toLowerCase();

/** The tray of one comment being written. `upload(blob, versionOf)` stores a picture and resolves its { hex, name, contentType, size }; `onChange()` is told whenever the pictures or their state change. */
export function createImageTray({ upload, onChange = () => {} }) {
    const node = el('div', 'ac-images'); node.hidden = true;
    const list = el('ul', 'ac-thumbs'); list.setAttribute('aria-label', 'Pictures to send with this comment');
    const note = el('p', 'ac-images-note'); note.setAttribute('role', 'status'); note.hidden = true;
    node.append(list, note);
    const items = [];
    let seq = 0, destroyed = false, change = onChange;

    const say = (text) => { note.textContent = text || ''; note.hidden = !text; };
    const draw = () => {
        list.replaceChildren(...items.map(it => {
            const li = el('li', `ac-thumb ac-thumb-${it.state}`);
            const img = el('img', 'ac-thumb-img'); img.src = it.previewUrl; img.alt = it.name || 'Picture'; img.decoding = 'async';
            const stateText = it.state === 'uploading' ? 'Uploading…' : it.state === 'failed' ? (it.error || 'Not stored') : '';
            const state = el('span', 'ac-thumb-state', stateText); state.hidden = !stateText; if (it.state === 'failed') state.setAttribute('role', 'alert');
            const rm = el('button', 'btn btn-small ac-thumb-remove', 'Remove'); rm.type = 'button'; rm.setAttribute('aria-label', `Remove ${it.name || 'picture'}`);
            rm.addEventListener('click', () => remove(it.id));
            li.append(img, state, rm);
            return li;
        }));
        node.hidden = items.length === 0 && note.hidden;
        change();
    };
    function remove(id) {
        const i = items.findIndex(x => x.id === id); if (i < 0) return;
        const [it] = items.splice(i, 1); URL.revokeObjectURL(it.previewUrl);
        say(''); draw();
    }
    /** Adds the pictures among `files` (anything else is said and left out); each starts to upload at once. */
    function add(files) {
        const picked = [...files || []];
        const ok = [], bad = [];
        for (const f of picked) (api.COMMENT_IMAGE_TYPES.includes(typeOf(f)) && f.size <= MAX_BYTES ? ok : bad).push(f);
        const room = api.COMMENT_IMAGE_MAX - items.length, take = ok.slice(0, Math.max(room, 0)), over = ok.length - take.length;
        const notes = [];
        if (bad.length) notes.push(bad.some(f => f.size > MAX_BYTES) && bad.every(f => api.COMMENT_IMAGE_TYPES.includes(typeOf(f))) ? 'That picture is larger than 25 MB.' : 'Only PNG, JPEG and WebP pictures can be added.');
        if (over > 0) notes.push(`A comment carries at most ${api.COMMENT_IMAGE_MAX} pictures.`);
        say(notes.join(' '));
        for (const f of take) {
            const it = { id: ++seq, name: f.name || 'pasted-image', blob: f, previewUrl: URL.createObjectURL(f), hex: '', state: 'uploading', error: '' };
            items.push(it);
            Promise.resolve().then(() => upload(f)).then(r => { it.hex = r.hex; it.state = 'ready'; }, e => { it.state = 'failed'; it.error = e && e.message ? e.message : 'Not stored'; }).finally(() => { if (!destroyed) draw(); });
        }
        draw();
    }
    /** A marked-up version of a picture replaces it, its first version's series staying the comment's (#11654): the new blob is shown and the new hex is what Send names. */
    function replaceBlob(id, blob, hex) {
        const it = items.find(x => x.id === id); if (!it) return;
        URL.revokeObjectURL(it.previewUrl); it.blob = blob; it.previewUrl = URL.createObjectURL(blob); it.hex = hex; it.state = 'ready'; it.error = '';
        draw();
    }
    /** The button and the hidden picker behind it; on a phone the picker offers the photos. */
    function picker() {
        const wrap = el('span', 'ac-picker');
        const input = el('input'); input.type = 'file'; input.accept = api.COMMENT_IMAGE_TYPES.join(','); input.multiple = true; input.hidden = true; input.tabIndex = -1; input.setAttribute('aria-hidden', 'true');
        const b = el('button', 'btn btn-small ac-add-image', 'Add image'); b.type = 'button'; b.setAttribute('aria-label', 'Add an image to this comment');
        b.addEventListener('click', () => input.click());
        input.addEventListener('change', () => { add(input.files); input.value = ''; });
        wrap.append(b, input);
        return wrap;
    }
    /** Pasting a picture into the text, and dropping one on the form, add it; pasted text is left to the field. */
    function attach(form, field) {
        field.addEventListener('paste', e => {
            const cd = e.clipboardData; if (!cd) return;
            const files = [...cd.files || []].filter(f => typeOf(f).startsWith('image/'));
            if (files.length && !cd.getData('text/plain')) { e.preventDefault(); add(files); }
        });
        const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types || []].includes('Files');
        form.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); form.classList.add('ac-drop'); });
        form.addEventListener('dragleave', e => { if (!form.contains(e.relatedTarget)) form.classList.remove('ac-drop'); });
        form.addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); form.classList.remove('ac-drop'); add(e.dataTransfer.files); });
    }
    /** Takes every picture out (a goal's form whose team changed: the pictures were stored on the other one). */
    function clear(words) { for (const it of items) URL.revokeObjectURL(it.previewUrl); items.length = 0; say(words || ''); draw(); }
    function destroy() { destroyed = true; for (const it of items) URL.revokeObjectURL(it.previewUrl); items.length = 0; list.replaceChildren(); }
    return {
        node, add, remove, replaceBlob, picker, attach, clear, destroy,
        items: () => items.map(it => ({ id: it.id, name: it.name, blob: it.blob, hex: it.hex, state: it.state })),
        hexes: () => items.filter(it => it.state === 'ready').map(it => it.hex),
        busy: () => items.some(it => it.state === 'uploading'),
        failed: () => items.some(it => it.state === 'failed'),
        listen: fn => { change = fn || (() => {}); },
    };
}
