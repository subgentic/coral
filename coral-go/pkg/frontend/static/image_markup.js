/* Mark up an image before it goes into a comment (#11654, Goal #184 slice 2; the plan is coral://artifacts/7471407373db7cb7fac218f95edb3b7436bdff4d63b237d7839bedd7c177375c). openMarkup(blob) opens a dialog (the whole screen on
 * a phone) with the picture and three tools, Pen, Arrow and Box, in one colour, and resolves with the picture and its marks flattened to one PNG (Done), or null (Cancel, Escape, or Done with no marks). The marks are a list
 * of shapes redrawn on every change, so Undo is dropping the last one and the export draws the same list at the picture's own size (long edge capped at 2048). Drawing is pointer events on a canvas with touch-action none; a
 * person without a pointer skips it and writes the area in words: marking up is never required. Lazy: only Mark up loads it, so the first-load graph does not grow. */
import { loadStyles } from './lazy_styles.js';
await loadStyles('image_markup.css');

const MARK = '#e5484d', MAX_EDGE = 2048;
const KEPT = 'The original is kept as an earlier version and the team\'s agents can see it. To hide something, remove the original instead.';
const TOOLS = [['pen', 'Pen'], ['arrow', 'Arrow'], ['box', 'Box']];

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** The picture as something drawable, scaled so its long edge is at most MAX_EDGE. */
async function load(blob) {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    return { bmp, w: Math.max(1, Math.round(bmp.width * k)), h: Math.max(1, Math.round(bmp.height * k)) };
}

/** One shape on the canvas: { tool, pts } with pts the pen's points, or [from, to] for an arrow and a box. */
function drawShape(ctx, s, width) {
    ctx.strokeStyle = MARK; ctx.fillStyle = MARK; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const [a, b] = [s.pts[0], s.pts[s.pts.length - 1]];
    ctx.beginPath();
    if (s.tool === 'pen') {
        ctx.moveTo(a.x, a.y);
        if (s.pts.length === 1) ctx.lineTo(a.x + 0.01, a.y); // a tap is a dot
        for (const p of s.pts.slice(1)) ctx.lineTo(p.x, p.y);
    } else if (s.tool === 'box') ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    else { // arrow: the shaft and a head of two strokes at the tip
        const ang = Math.atan2(b.y - a.y, b.x - a.x), head = width * 5, spread = Math.PI / 7;
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        for (const d of [-spread, spread]) { ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - head * Math.cos(ang + d), b.y - head * Math.sin(ang + d)); }
    }
    ctx.stroke();
}

export async function openMarkup(blob) {
    const pic = await load(blob);
    const opener = document.activeElement;
    return new Promise(resolve => {
        const dlg = el('dialog', 'modal-content dlg-flow markup-dialog'); dlg.setAttribute('aria-labelledby', 'markup-title');
        const title = el('h2', 'markup-title', 'Mark up image'); title.id = 'markup-title';
        const tools = el('div', 'markup-tools'); tools.setAttribute('role', 'group'); tools.setAttribute('aria-label', 'Drawing tools');
        const pick = {}; let tool = 'pen';
        for (const [key, label] of TOOLS) {
            const b = el('button', 'btn btn-small', label); b.type = 'button'; b.setAttribute('aria-pressed', String(key === tool)); b.dataset.tool = key; pick[key] = b;
            b.addEventListener('click', () => { tool = key; for (const k in pick) pick[k].setAttribute('aria-pressed', String(k === key)); });
            tools.append(b);
        }
        const undo = el('button', 'btn btn-small', 'Undo'); undo.type = 'button'; undo.disabled = true;
        const say = el('p', 'markup-status'); say.setAttribute('role', 'status');
        const canvas = el('canvas', 'markup-canvas'); canvas.width = pic.w; canvas.height = pic.h; canvas.setAttribute('aria-label', 'The image: draw on it with a pen, finger or mouse');
        const cancel = el('button', 'btn', 'Cancel'); cancel.type = 'button';
        const done = el('button', 'btn btn-primary', 'Done'); done.type = 'button'; done.disabled = true;
        const bar = el('div', 'markup-controls'); bar.append(tools, undo);
        const keptNote = el('p', 'markup-kept', KEPT);
        const foot = el('div', 'markup-foot'); foot.append(cancel, done);
        dlg.append(title, bar, el('div', 'markup-stage'), say, keptNote, foot); dlg.querySelector('.markup-stage').append(canvas);
        const ctx = canvas.getContext('2d'), width = Math.max(3, Math.round(Math.max(pic.w, pic.h) / 150));
        const marks = []; let live = null;
        const paint = () => { ctx.clearRect(0, 0, pic.w, pic.h); ctx.drawImage(pic.bmp, 0, 0, pic.w, pic.h); for (const s of marks) drawShape(ctx, s, width); if (live) drawShape(ctx, live, width); };
        const sync = () => { undo.disabled = !marks.length; done.disabled = !marks.length; say.textContent = marks.length ? `${marks.length} mark${marks.length === 1 ? '' : 's'}` : ''; paint(); };
        const at = e => { const r = canvas.getBoundingClientRect(); return { x: Math.min(pic.w, Math.max(0, (e.clientX - r.left) * pic.w / r.width)), y: Math.min(pic.h, Math.max(0, (e.clientY - r.top) * pic.h / r.height)) }; };
        canvas.addEventListener('pointerdown', e => { if (e.button > 0 && e.pointerType !== 'touch') return; e.preventDefault(); canvas.setPointerCapture?.(e.pointerId); live = { tool, pts: [at(e)] }; paint(); });
        canvas.addEventListener('pointermove', e => { if (!live) return; if (live.tool === 'pen') live.pts.push(at(e)); else live.pts = [live.pts[0], at(e)]; paint(); });
        const lift = e => { if (!live) return; const s = live; live = null; if (e.type === 'pointerup') { if (s.tool === 'pen' || s.pts.length > 1) marks.push(s); } sync(); };
        canvas.addEventListener('pointerup', lift); canvas.addEventListener('pointercancel', lift);
        undo.addEventListener('click', () => { marks.pop(); sync(); });
        dlg.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); if (marks.length) { marks.pop(); sync(); } } });
        let settled = false;
        const finish = out => { if (settled) return; settled = true; pic.bmp.close?.(); dlg.close(); dlg.remove(); try { opener?.focus?.({ preventScroll: true }); } catch { /* gone */ } resolve(out); };
        cancel.addEventListener('click', () => finish(null));
        dlg.addEventListener('cancel', e => { e.preventDefault(); finish(null); });
        done.addEventListener('click', () => { live = null; paint(); canvas.toBlob(b => finish(b || null), 'image/png'); });
        document.body.append(dlg); dlg.showModal(); sync(); pick.pen.focus();
    });
}
