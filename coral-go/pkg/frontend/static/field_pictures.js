/* Pictures on prose fields (#20787). Each controller captures its computer, team,
 * upload scope and draft once; switching pages never retargets an upload. Lazy. */
import { importOnce } from './import_once.js';
const { createImageTray } = await importOnce('./artifact_comment_images.js');
import { serverUrl, splitKey } from './server_base.js';
const HEX = /^[a-f0-9]{64}$/;
export const savedWords = (out, words) => out?.pictures_not_saved ? (out.pictures_warning || 'Pictures not saved: your words were saved, but the pictures were not. Attach them again.') : words;
export function createFieldPictures({ project, server, scope = 'task', field, initial = [], draft = 'pictures-' + crypto.randomUUID(), onChange = () => {}, hintWhenAdded = false, uploadPicture = null, includeDraft = true }) {
    const target = project ? splitKey(project) : { server, local: '' };
    const computer = target.server || server;
    const board = project ? (target.local || target.name || project) : '';
    let original = initial.map(x => x.hex).filter(x => HEX.test(x));
    const upload = async (blob, uploadScope = scope) => {
            const path = board ? `/api/board/${encodeURIComponent(board)}/field-images` : '/api/field-images';
            const r = await fetch(serverUrl(`${path}?scope=${uploadScope}&draft=${draft}`, computer), { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
            const out = await r.json().catch(() => ({}));
            if (!r.ok || !HEX.test(out.hex || '')) throw new Error(out.error || out.message || `Picture not uploaded (HTTP ${r.status}).`);
            return out;
    };
    let changedListener = onChange;
    const tray = createImageTray({
        initial: initial.map(x => ({ ...x, previewUrl: serverUrl(`/api/artifacts/${x.hex}?v=2`, computer) })),
        read: async it => { const r = await fetch(it.previewUrl); if (!r.ok) throw new Error('The picture could not be opened.'); return r.blob(); },
        upload: uploadPicture || upload,
    });
    const node = document.createElement('div'); node.className = 'field-pictures'; node.dataset.pictureField = field;
    node.append(tray.node, tray.picker(), tray.hint());
    const syncHint = () => { node.querySelector('.ac-images-hint').hidden = hintWhenAdded && tray.items().length === 0; };
    syncHint();
    tray.listen(() => { syncHint(); changedListener(); });
    const changed = () => JSON.stringify(tray.hexes()) !== JSON.stringify(original);
    const assertReady = () => { if (tray.busy()) throw new Error('Wait for the pictures to finish uploading.'); if (tray.failed()) throw new Error('Retry or remove the picture that did not upload before saving.'); };
    return { ...tray, node, changed, assertReady,
        acceptSaved: () => { original = tray.hexes(); },
        listen: fn => { changedListener = fn || (() => {}); },
        payloadFor: async (otherScope, otherField) => {
            assertReady();
            const uploaded = await Promise.all(tray.items().map(async it => upload(it.blob || await (await fetch(serverUrl(`/api/artifacts/${it.hex}?v=2`, computer))).blob(), otherScope)));
            return { images: { [otherField]: uploaded.map(it => it.hex) }, images_draft: draft };
        },
        payload: () => { assertReady(); return changed() ? { images: { [field]: tray.hexes() }, ...(includeDraft ? { images_draft: draft } : {}) } : {}; },
        mount: (host, input) => { host.append(node); tray.attach(node, input); return node; },
    };
}

export function picturePayload(...controllers) {
    const images = {}; let draft;
    for (const c of controllers) { if (!c) continue; const p = c.payload(); if (p.images) { Object.assign(images, p.images); draft = p.images_draft; } }
    return Object.keys(images).length ? { images, images_draft: draft } : {};
}
export function mountFieldPictures(input, options) {
    const c = createFieldPictures(options);
    const anchor = input.closest('label') || input; anchor.before(c.node); c.node.prepend(anchor);
    c.attach(c.node, input);
    return c;
}
