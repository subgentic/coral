// The contact sheet: ONE HTML page with a grid of page by width, each thumbnail linking to its full image (a Coral artifact). What changed since the last release comes first, with the before, the
// after and the diff image; the pages that did not change are folded into a list. Thumbnails are small PNGs inside the page, so the sheet opens with no other file.
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A PNG scaled down to `width` pixels wide by averaging boxes of pixels (no other image library), as a data: URI. */
export function thumbnail(buf, width = 320) {
    const src = PNG.sync.read(buf);
    const scale = Math.min(1, width / src.width);
    const w = Math.max(1, Math.round(src.width * scale)), h = Math.max(1, Math.round(src.height * scale));
    const out = new PNG({ width: w, height: Math.min(h, 2400) });
    const hh = out.height;
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
        const x0 = Math.floor(x / scale), x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((x + 1) / scale)));
        const y0 = Math.floor(y / scale), y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((y + 1) / scale)));
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = y0; yy < y1 && yy < src.height; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * src.width + xx) * 4; r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; n++; }
        const o = (y * w + x) * 4; n = n || 1;
        out.data[o] = r / n; out.data[o + 1] = g / n; out.data[o + 2] = b / n; out.data[o + 3] = 255;
    }
    return 'data:image/png;base64,' + PNG.sync.write(out).toString('base64');
}

const CSS = `:root{--bg:#f6f7f8;--fg:#1c2127;--mute:#5b6670;--line:#d9dde1;--card:#fff;--chg:#8a5a00;--chg-bg:#fdf1d8;--new:#1b6b3a;--new-bg:#e3f3e8}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#14181c;--fg:#e4e8ec;--mute:#9aa5af;--line:#2c343b;--card:#1b2127;--chg:#f0c36a;--chg-bg:#392d12;--new:#7fd69b;--new-bg:#14301f}}
:root[data-theme="dark"]{--bg:#14181c;--fg:#e4e8ec;--mute:#9aa5af;--line:#2c343b;--card:#1b2127;--chg:#f0c36a;--chg-bg:#392d12;--new:#7fd69b;--new-bg:#14301f}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px max(16px,env(safe-area-inset-right)) 48px max(16px,env(safe-area-inset-left))}
main{max-width:1200px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px}p{margin:0}.sub,.mute{color:var(--mute)}
.page{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;margin:0 0 12px}.page h3{font-size:14px;margin:0 0 8px;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start}.shot{display:flex;flex-direction:column;gap:4px;max-width:340px}.shot img{max-width:100%;border:1px solid var(--line);border-radius:4px;display:block}
.shot small{color:var(--mute)}.pill{font-size:11px;font-weight:600;padding:1px 7px;border-radius:9px}.changed{background:var(--chg-bg);color:var(--chg)}.new{background:var(--new-bg);color:var(--new)}
details{margin:8px 0}summary{cursor:pointer}ul.fold{columns:3 280px;margin:8px 0;padding-left:18px}code{font:12px ui-monospace,Menlo,monospace}`;

/**
 * manifest: manifest.mjs's; links: { artifactName: 'coral://artifacts/...' }; dir: the run's folder (the shots and diff images); prevDir: the previous version's shots or null.
 */
export function buildSheet({ manifest: m, links, dir, prevDir }) {
    const link = a => links[a.name] || '';
    const img = (file, label, href) => {
        const p = path.join(dir, file);
        if (!fs.existsSync(p)) return '';
        const tag = `<img src="${thumbnail(fs.readFileSync(p))}" alt="${esc(label)}" loading="lazy">`;
        return `<div class="shot"><small>${esc(label)}</small>${href ? `<a href="${esc(href)}">${tag}</a>` : tag}</div>`;
    };
    const byPage = new Map();
    for (const a of m.artifacts) { if (!byPage.has(a.page)) byPage.set(a.page, []); byPage.get(a.page).push(a); }
    const pageStatus = shots => (shots.some(s => s.status === 'changed') ? 'changed' : shots.every(s => s.status === 'new') ? 'new' : shots.every(s => s.status === 'baseline') ? 'baseline' : 'unchanged');
    const card = (page, shots) => {
        const st = pageStatus(shots);
        const rows = shots.map(a => {
            const parts = [];
            if (a.status === 'changed' && prevDir && fs.existsSync(path.join(prevDir, a.file))) parts.push(img(path.relative(dir, path.join(prevDir, a.file)), `before ${a.width}`, ''));
            parts.push(img(a.file, `${a.status === 'changed' ? 'after ' : ''}${a.width}`, link(a)));
            if (a.diff) parts.push(img(a.diff, `diff ${a.width} (${a.diffPixels} px)`, ''));
            return parts.join('');
        }).join('');
        const notes = [...new Set(shots.map(s => s.notes).filter(Boolean))].join(' ');
        return `<section class="page" id="${esc(page)}"><h3><code>${esc(page)}</code>${st === 'changed' || st === 'new' ? `<span class="pill ${st}">${st}</span>` : ''}<span class="mute">${esc(notes)}</span></h3><div class="row">${rows}</div></section>`;
    };
    const pages = [...byPage.entries()];
    const changed = pages.filter(([, s]) => ['changed', 'new'].includes(pageStatus(s)));
    const baseline = pages.filter(([, s]) => pageStatus(s) === 'baseline');
    const same = pages.filter(([, s]) => pageStatus(s) === 'unchanged');
    const parts = [];
    parts.push(`<h1>UI review: ${esc(m.tag)}</h1><p class="sub">${m.pageCount} pages, ${m.shotCount} shots at ${esc(m.widths.join(', '))} px (${esc(m.themes.join(', '))}); build ${esc(String(m.sha || '').slice(0, 12))}; ${esc(m.ranAt)}</p>`);
    if (baseline.length) parts.push(`<h2>Every page</h2><p class="mute">No earlier release to compare with: this run is the baseline for the next one.</p>`, ...baseline.map(([p, s]) => card(p, s)));
    else {
        parts.push(`<h2>Changed since the last release (${changed.length})</h2>`);
        parts.push(changed.length ? changed.map(([p, s]) => card(p, s)).join('') : '<p class="mute">No page changed.</p>');
        parts.push(`<h2>Unchanged (${same.length})</h2><details><summary>Show the list</summary><ul class="fold">${same.map(([p, s]) => `<li>${esc(p)}: ${s.map(a => (link(a) ? `<a href="${esc(link(a))}">${esc(a.width)}</a>` : esc(a.width))).join(' ')}</li>`).join('')}</ul></details>`);
    }
    if (m.failed.length) parts.push(`<h2>Not photographed (${m.failed.length})</h2><ul class="fold">${m.failed.map(f => `<li><code>${esc(f.page)}</code> at ${esc(f.width)}: ${esc(f.error)}</li>`).join('')}</ul>`);
    return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>UI review ${esc(m.tag)}</title><style>${CSS}</style></head><body><main>${parts.join('\n')}</main></body></html>\n`;
}
