/* The pictures of a comment being written (#11651, goal #184): paste, drop or pick one or more, each shows as a thumbnail before Send and can be removed; each is stored as it is added (POST comment-images), so Send only names
 * what is already stored and the marked-up version of a picture (a second version of the same artifact) has its first version's hex to follow. A phone's picker offers the photos. Everything the person or the server wrote is set as
 * text or as an attribute, never as HTML. The tray is kept by the composing state, so a redraw of the panel gives the same node back with its pictures. */
import { importOnce } from './import_once.js';
import { loadStyles } from './lazy_styles.js';
const { drawPictureTray } = await importOnce('./picture_tray.js');
const api = await importOnce('./artifact_comments_api.js'); // lazy: its failure is retried
await loadStyles('pictures.css'); // the picture rules load with this module, before anything draws (page_weight: not at start)
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const HINT = 'Pictures are shared with this team\'s agents as they are; nothing is hidden.';
const MAX_BYTES = 25 * 1024 * 1024; // a larger file is refused here with the reason; the server's own cap is the one that counts
const typeOf = f => String((f && f.type) || '').toLowerCase();

/** The tray of one comment being written. `upload(blob, versionOf)` stores (versionOf only on a marked-up copy) a picture and resolves its { hex, name, contentType, size }; `onChange()` is told whenever the pictures or their state change. */
export function createImageTray({ upload, onChange = () => {}, hintText = HINT, initial = [], read }) {
    const node = el('div', 'ac-images'); node.hidden = true;
    const list = el('ul', 'ac-thumbs'); list.setAttribute('aria-label', 'Pictures to send');
    const note = el('p', 'ac-images-note'); note.hidden = true;
    node.append(list, note);
    const detach = [];
    const items = initial.map((it, i) => ({ ...it, id: i + 1, state: 'ready' }));
    let seq = items.length, destroyed = false, change = onChange;

    const say = (text) => { note.textContent = text || ''; note.hidden = !text; if (text) note.setAttribute('role', 'status'); else note.removeAttribute('role'); };
    const draw = () => {
        drawPictureTray(list, items, { remove: i => remove(items[i].id), retry: i => store(items[i]), markUp: i => markUp(items[i].id) });
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
        if (destroyed) return;
        const picked = [...files || []];
        const ok = [], bad = [];
        for (const f of picked) (api.COMMENT_IMAGE_TYPES.includes(typeOf(f)) && f.size <= MAX_BYTES ? ok : bad).push(f);
        const room = api.COMMENT_IMAGE_MAX - items.length, take = ok.slice(0, Math.max(room, 0)), over = ok.length - take.length;
        const notes = [];
        if (bad.length) notes.push(bad.some(f => f.size > MAX_BYTES) && bad.every(f => api.COMMENT_IMAGE_TYPES.includes(typeOf(f))) ? 'That picture is larger than 25 MB.' : 'Only PNG, JPEG and WebP pictures can be added.');
        if (over > 0) notes.push(`You can add at most ${api.COMMENT_IMAGE_MAX} pictures here.`);
        say(notes.join(' '));
        for (const f of take) {
            const it = { id: ++seq, name: f.name || 'pasted-image', blob: f, previewUrl: URL.createObjectURL(f), hex: '', state: 'uploading', error: '' };
            items.push(it);
            store(it);
        }
        draw();
    }
    function store(it) {
        if (destroyed || !items.includes(it) || it.pending) return;
        it.state = 'uploading'; it.error = ''; it.pending = true;
        Promise.resolve().then(() => upload(it.blob, undefined)).then(r => { it.hex = r.hex; it.state = 'ready'; }, e => { it.state = 'failed'; it.error = e && e.message ? e.message : 'Picture not uploaded.'; }).finally(() => { it.pending = false; if (!destroyed && items.includes(it)) draw(); });
        draw();
    }
    /** Mark up (#11654): the editor loads on the first use, its picture goes up as the next version of the one it marks (`versionOf` is the first version's hex, kept through repeated marking), and replaces it here. Cancel, or Done with no marks, changes nothing. */
    async function markUp(id) {
        const it = items.find(x => x.id === id); if (!it || it.state !== 'ready' || it.marking) return;
        it.marking = true;
        try {
            const { openMarkup } = await importOnce('./image_markup.js'); // lazy: only Mark up loads it
            const out = await openMarkup(it.blob || await read(it));
            if (!out || destroyed || !items.includes(it)) return;
            const first = it.first || it.hex; it.state = 'uploading'; say(''); draw();
            try { const r = await upload(out, first); if (!items.includes(it)) return; it.first = first; replaceBlob(id, out, r.hex); }
            catch (e) { it.state = 'ready'; say(e && e.message ? e.message : 'The marked picture was not stored.'); draw(); }
        } catch { say('The markup editor could not be opened.'); }
        finally { it.marking = false; if (!destroyed) draw(); }
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
        const b = el('button', 'btn btn-small ac-add-image', 'Add image'); b.type = 'button'; b.setAttribute('aria-label', 'Add image'); b.title = 'Pictures only: PNG, JPEG or WebP. To give the team any other file, use Add files on the Artifacts tab.'; // said before a file is picked (#15317), not only after a refusal
        b.addEventListener('click', () => input.click());
        input.addEventListener('change', () => { add(input.files); input.value = ''; });
        wrap.append(b, input);
        return wrap;
    }
    /** The one quiet line beside Add image (Security's INFO on #11650): what happens to a picture once it is sent. */
    const hint = () => el('p', 'ac-images-hint', hintText);
    /** Pasting a picture into the text, and dropping one on the form, add it; pasted text is left to the field. */
    function attach(form, field) {
        const on = (host, type, fn) => { host.addEventListener(type, fn); detach.push(() => host.removeEventListener(type, fn)); };
        on(field, 'paste', e => {
            const cd = e.clipboardData; if (!cd) return;
            const files = [...cd.files || []].filter(f => typeOf(f).startsWith('image/'));
            if (files.length && !cd.getData('text/plain')) { e.preventDefault(); add(files); }
        });
        const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types || []].includes('Files');
        on(form, 'dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); form.classList.add('ac-drop'); });
        on(form, 'dragleave', e => { if (!form.contains(e.relatedTarget)) form.classList.remove('ac-drop'); });
        on(form, 'drop', e => { if (!hasFiles(e)) return; e.preventDefault(); form.classList.remove('ac-drop'); add(e.dataTransfer.files); });
    }
    /** Takes every picture out (a goal's form whose team changed: the pictures were stored on the other one). */
    function clear(words) { for (const it of items) URL.revokeObjectURL(it.previewUrl); items.length = 0; say(words || ''); draw(); }
    function destroy() { destroyed = true; for (const off of detach.splice(0)) off(); for (const it of items) URL.revokeObjectURL(it.previewUrl); items.length = 0; list.replaceChildren(); }
    if (items.length) draw();
    return {
        node, add, remove, replaceBlob, picker, hint, attach, clear, destroy,
        detach: () => { for (const off of detach.splice(0)) off(); },
        items: () => items.map(it => ({ id: it.id, name: it.name, blob: it.blob, hex: it.hex, state: it.state })),
        hexes: () => items.filter(it => it.state === 'ready').map(it => it.hex),
        busy: () => items.some(it => it.state === 'uploading'),
        failed: () => items.some(it => it.state === 'failed'),
        listen: fn => { change = fn || (() => {}); },
    };
}
