import { importOnce } from './import_once.js';
const { artifactThumbnail, thumbnailPath } = await importOnce('./artifact_thumbnail.js');
/* Versions of an artifact in the viewer (#6357, #6472 layout A): a bar under the title for an artifact that is one of several versions of a series: Previous and Next, "v3 of 3" opening the list of
 * every version (a listbox, newest first), and "Compare with v2". Compare draws the text's lines that were added and removed since the version before (Changes) or the two versions side by side. All
 * text is set with textContent. The server's list is GET /api/artifacts/{digest}/versions (an artifact in no series is a 404: no bar). A switch and a compare are said once in a polite line. */
import { serverUrl, artifactPath } from './server_base.js';
const { readVersions } = await importOnce('./versions_read.js');
import { el } from './dom_el.js';
import { pollEvery } from './overload.js';

const btn = (cls, text, label) => { const b = el('button', 'btn btn-small ' + cls, text); b.type = 'button'; if (label) b.setAttribute('aria-label', label); return b; };
const sr = (text) => el('span', 'sr-only', text);

const TEXTY = /^(text\/|application\/(json|xml|yaml|x-yaml|toml)|application\/.*\+(json|xml))/i;
const MAX_LINES = 4000, MAX_CELLS = 6e6, CONTEXT = 3;

/** A version's time as people say it ("today 08:15", "yesterday 16:40", "Oct 21 09:00"), and the full time for a title and a status line. */
export function whenOf(iso, now = new Date()) {
    const t = new Date(iso);
    if (isNaN(t)) return { label: '', full: '' };
    const hm = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((day(now) - day(t)) / 86400000);
    const label = diff === 0 ? `today ${hm}` : diff === 1 ? `yesterday ${hm}` : `${t.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
    return { label, full: t.toLocaleString() };
}

const sizeOf = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/** The lines of `b` that are added and the lines of `a` that are removed: [{ t: 'same'|'add'|'del', text }] in reading order, or null when the two are too long to compare line by line. */
export function diffLines(a, b) {
    const x = a.split('\n'), y = b.split('\n');
    let lo = 0;
    while (lo < x.length && lo < y.length && x[lo] === y[lo]) lo++;
    let hx = x.length, hy = y.length;
    while (hx > lo && hy > lo && x[hx - 1] === y[hy - 1]) { hx--; hy--; }
    const mx = x.slice(lo, hx), my = y.slice(lo, hy);
    if (x.length > MAX_LINES || y.length > MAX_LINES || mx.length * my.length > MAX_CELLS) return null;
    // the longest common subsequence of the middle, by the usual table
    const w = my.length + 1, tab = new Uint16Array((mx.length + 1) * w);
    for (let i = mx.length - 1; i >= 0; i--) for (let j = my.length - 1; j >= 0; j--) {
        tab[i * w + j] = mx[i] === my[j] ? tab[(i + 1) * w + j + 1] + 1 : Math.max(tab[(i + 1) * w + j], tab[i * w + j + 1]);
    }
    const out = [];
    for (let i = 0; i < lo; i++) out.push({ t: 'same', text: x[i] });
    let i = 0, j = 0;
    while (i < mx.length || j < my.length) {
        if (i < mx.length && j < my.length && mx[i] === my[j]) { out.push({ t: 'same', text: mx[i] }); i++; j++; }
        else if (i < mx.length && (j === my.length || tab[(i + 1) * w + j] >= tab[i * w + j + 1])) { out.push({ t: 'del', text: mx[i] }); i++; } // a removed line before the line that replaces it
        else { out.push({ t: 'add', text: my[j] }); j++; }
    }
    for (let k = hx; k < x.length; k++) out.push({ t: 'same', text: x[k] });
    return out;
}

/** Wire the version bar into the viewer `dialog`. hooks: show(row) opens that version, reload() draws the version on show again, body() is the element the document is drawn in. Returns { open, close }. */
export function attachVersions(dialog, hooks) {
    const bar = el('div', 'pane-head pane-head-bar av-bar'); bar.hidden = true;
    bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'Versions');
    const live = el('div', 'sr-only av-live'); live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); live.setAttribute('aria-atomic', 'true');
    let flip = false;
    const say = (msg) => { flip = !flip; live.textContent = msg + (flip ? '' : ' '); };
    (dialog.querySelector('.artifact-viewer-chips') || dialog.querySelector('.artifact-viewer-header')).append(bar); // the version chip is on the header's one row (#12223)
    const note = el('span', 'av-note'); note.hidden = true; // a file two teams hold has no version bar from a link with no team: said quietly, not as an error (#14015)
    bar.after(note);
    dialog.append(live);
    const st = { hex: null, server: undefined, board: '', ambiguous: false, rows: null, listOpen: false, comparing: false, view: 'changes', gen: 0, abort: null };
    let liveTimer = 0, liveBusy = -1;
    async function refreshVersions() {
        if (!st.hex || dialog.hidden || !dialog.isConnected || st.comparing || st.listOpen || liveBusy === st.gen) return;
        const gen = st.gen, hex = st.hex, server = st.server, board = st.board;
        liveBusy = gen;
        try {
            const { rows, ambiguous } = await load(hex, server, board);
            if (gen !== st.gen || hex !== st.hex || server !== st.server || board !== st.board || dialog.hidden || st.comparing || st.listOpen) return; // the file, computer or team changed meanwhile: this answer is not for it
            if (ambiguous) { if (st.rows || !st.ambiguous) { st.rows = null; st.ambiguous = true; draw(); } return; } // a second team now holds the bytes: the bar that was valid is gone, and the note says why
            if (!rows || JSON.stringify(rows) === JSON.stringify(st.rows)) return;
            st.ambiguous = false; st.rows = rows;
            draw();
            say('A new version is available');
        } finally { if (liveBusy === gen) liveBusy = -1; }
    }
    const cur = () => st.rows ? st.rows.findIndex(r => r.digest === st.hex) : -1;
    const nameOf = (r) => `v${r.version}`;

    /** One read of the version list: { rows, ambiguous }. The answer carries its own state: it is applied only by the caller whose generation, file, computer and team it was asked for, so an older answer can never change a newer context (#14015). */
    async function load(hex, server, board = '') {
        try {
            // The version bar asks for its own team's series: bytes two teams hold are two series, and the route will not guess between them (#13999, #14015). A direct link with no team asks without one.
            // A computer on an older release refuses ?board= (its versions route takes no query): there is no bar then. Asked again without the team, its answer would be that computer's guess at a series, and a hidden bar is honest where a guess is not (#14317, Security's INFO 4).
            const { response: r, dropped } = await readVersions(server, hex, board);
            if (dropped.length) return { rows: null, ambiguous: false };
            if (r.status === 409) { const d = await r.json().catch(() => ({})); return { rows: null, ambiguous: !!(d && d.code === 'ambiguous_series') }; } // no bar, a quiet note
            if (!r.ok) return { rows: null, ambiguous: false };
            const d = await r.json();
            return { rows: Array.isArray(d) && d.length > 1 ? d.slice().sort((p, q) => p.version - q.version) : null, ambiguous: false }; // one version is no series to move in
        } catch { return { rows: null, ambiguous: false }; }
    }

    // Open or close the list in place: the bar's buttons are not redrawn (a Tab walk or a screen reader holds them).
    function setList(open) {
        st.listOpen = open;
        bar.querySelector('.av-current')?.setAttribute('aria-expanded', String(open));
        const pop = bar.querySelector('.av-pop'); if (pop) pop.hidden = !open;
    }
    function closeList(focusButton) {
        if (!st.listOpen) return;
        setList(false);
        if (focusButton) bar.querySelector('.av-current')?.focus();
    }
    bar.addEventListener('focusout', (e) => { if (st.listOpen && e.relatedTarget && !bar.contains(e.relatedTarget)) closeList(false); }); // Tab out of the bar closes the list it left
    document.addEventListener('click', (e) => { if (st.listOpen && !e.composedPath().includes(bar)) closeList(false); }); // the path as it was when the click began: a click on a button the bar then redrew is still the bar's

    function stepTo(delta) {
        const i = cur() + delta;
        if (!st.rows || i < 0 || i >= st.rows.length) return;
        choose(st.rows[i]);
    }
    function choose(row) {
        st.listOpen = false; st.comparing = false;
        hooks.show(row);
    }

    const unopenedCount = (rows, files) => files > 1 ? String([...new Set(rows.map(r => r.name).filter(Boolean))].filter(n => !rows.some(r => r.name === n && st.seen.has(r.digest))).length) : '';
    dialog.addEventListener('av-content', () => { // the shown version's content has rendered: now it counts as opened (#15254, #15636)
        if (dialog.dataset.contentPending || !st.rows || st.seenOf !== st.rows[0].digest) return;
        const i = cur(); if (i < 0) return;
        st.seen.add(st.rows[i].digest);
        const files = new Set(st.rows.map(r => r.name).filter(Boolean)).size;
        dialog.dataset.unopenedFiles = unopenedCount(st.rows, files); dialog.dispatchEvent(new CustomEvent('av-version'));
    });

    function draw() {
        const keepFocus = bar.contains(document.activeElement) ? document.activeElement.className.split(' ').find(c => c.startsWith('av-')) : '';
        bar.replaceChildren();
        const i = cur();
        bar.hidden = !st.rows || i < 0;
        if (bar.hidden) { dialog.dataset.shownVersion = dialog.dataset.newerVersion = ''; dialog.dispatchEvent(new CustomEvent('av-version')); }
        note.hidden = !st.ambiguous || !bar.hidden; note.textContent = note.hidden ? '' : 'Held by more than one team: open it from a team to see its versions.';
        hooks.version?.(bar.hidden ? 0 : st.rows[i].version);
        hooks.line?.(bar.hidden ? null : st.rows[i]); // the file id and line of the version SHOWN, from the server's list (#14178): a switch or a save never keeps another version's
        dialog.classList.toggle('av-has-versions', !bar.hidden);
        if (bar.hidden) return;
        const rows = st.rows, row = rows[i], total = rows.length, latest = i === total - 1;
        const wantLatest = hooks.wantLatest?.(); // asked once, for the first version drawn, so an open that already shows the newest uses it up (#15601: left set, it sent the person's next pick of v2 back to v3)
        if (!latest && wantLatest) { choose(rows[total - 1]); return; } // opened from Needs you: the newest version, not the one the row was made for
        const files = new Set(rows.map(r => r.name).filter(Boolean)).size; // one series can hold several files (a task's chain, #12144): a decision on the newest covers them all (#15233)
        dialog.dataset.coversFiles = files > 1 ? String(files) : '';
        if (st.seenOf !== rows[0].digest) { st.seenOf = rows[0].digest; st.seen = new Set(); } // the versions shown since this series opened: a file none of whose versions was shown has not been opened (#15254)
        if (!dialog.dataset.contentPending) st.seen.add(row.digest); // a version counts as shown when its content is on screen, not when the bar is drawn (#15636): else it is added by av-content below
        dialog.dataset.unopenedFiles = unopenedCount(rows, files);
        dialog.dataset.shownVersion = String(row.version); dialog.dataset.newerVersion = latest ? '' : String(rows[total - 1].version); dialog.dispatchEvent(new CustomEvent('av-version')); // the review bar names the version it approves (#15197)
        const prev = btn('av-prev av-icon', '◀', 'Previous version'); prev.setAttribute('aria-disabled', String(i === 0));
        prev.addEventListener('click', () => stepTo(-1));
        const next = btn('av-next av-icon', '▶', 'Next version'); next.setAttribute('aria-disabled', String(latest));
        next.addEventListener('click', () => stepTo(1));
        const current = btn('av-current', `v${row.version} of ${total}${st.comparing ? ' · comparing' : ''} ▾`, `Version: v${row.version} of ${total}${latest ? ', newest' : ''}`);
        current.setAttribute('aria-haspopup', 'listbox'); current.setAttribute('aria-expanded', String(st.listOpen)); current.setAttribute('aria-controls', 'av-list');
        current.addEventListener('click', () => { setList(!st.listOpen); if (st.listOpen) focusOption(); });
        current.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!st.listOpen) setList(true); focusOption(); } else if (e.key === 'Escape' && st.listOpen) { e.preventDefault(); e.stopPropagation(); closeList(true); } });
        bar.append(prev, current, next);
        if (i > 0 && latest && !st.comparing) { const since = btn('av-since', 'Changes', `Changes since v${rows[i - 1].version}`); since.title = `Changes since v${rows[i - 1].version}`; since.addEventListener('click', () => startCompare()); bar.append(since); } // a new version after a round of changes: the reviewer sees what changed without opening the list (walk 8 H2)
        if (!latest) { const newer = btn('av-link av-newer', `v${rows[total - 1].version} is ready: open it`); newer.addEventListener('click', () => choose(rows[total - 1])); bar.append(newer); } // said in the bar, not only inside the closed list (#15217, walk 6: the viewer stayed on 'version 1' with no word that a newer one is ready)
        const pop = el('div', 'av-pop'); pop.hidden = !st.listOpen; // Compare, the newer-version line and the list: opened by the chip
        if (i > 0) {
            const cmp = btn('av-compare', st.comparing ? `Back to v${row.version}` : `Compare with v${rows[i - 1].version}`);
            cmp.setAttribute('aria-pressed', String(st.comparing));
            cmp.addEventListener('click', () => { st.listOpen = false; (st.comparing ? leaveCompare() : startCompare()); }); // the list closes on Compare; the keyboard stays on the chip
            pop.append(cmp);
        }
        if (!latest) {
            const note = el('p', 'av-notice notice notice-info'); note.append(files > 1 ? `${rows[total - 1].name || 'The newest file'} (v${rows[total - 1].version}) is newer, and one decision on it covers all ${files} files. ` : `v${rows[total - 1].version} is newer. `);
            const open = el('button', 'av-link', 'Open the latest'); open.type = 'button'; open.addEventListener('click', () => choose(rows[total - 1]));
            note.append(open); pop.append(note);
        }
        const list = el('ul', 'av-list'); list.id = 'av-list'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'All versions');
        for (const r of rows.slice().reverse()) {
            const w = whenOf(r.at);
            // the shown version is the list's one Tab stop; the arrow keys move between the rest (a roving tabindex)
            const li = el('li', 'av-option'); li.setAttribute('role', 'option'); li.id = `av-opt-${r.version}`; li.tabIndex = r.digest === st.hex ? 0 : -1; li.dataset.version = String(r.version);
            li.setAttribute('aria-selected', String(r.digest === st.hex)); li.title = w.full;
            li.append(artifactThumbnail(r, { url: thumbnailPath(r) ? serverUrl(thumbnailPath(r), st.server) : '' }), el('span', 'av-vname', `v${r.version}${files > 1 && r.name ? ' ' + r.name : ''}${r.is_latest ? ' (latest)' : ''}`), el('span', 'av-who', r.edited_in_dropbox ? `Edited in Dropbox · ${w.label}` : [w.label, r.role === 'operator' ? 'You' : (r.uploader || r.role) ? `${r.uploader || r.role}, an agent` : ''].filter(Boolean).join(' · ')), el('span', 'av-size', sizeOf(r.size || 0)));
            li.addEventListener('click', () => choose(r));
            li.addEventListener('focus', () => { for (const o of options()) o.tabIndex = o === li ? 0 : -1; });
            list.append(li);
        }
        list.addEventListener('keydown', onListKey);
        pop.append(list); bar.append(pop);
        if (keepFocus) { bar.querySelector('.' + keepFocus)?.focus(); if (!bar.contains(document.activeElement)) bar.querySelector('.av-current')?.focus(); } // Compare is in the popover, closed after it is pressed: the keyboard stays on the chip that opened it
    }
    const options = () => [...bar.querySelectorAll('.av-option')];
    function focusOption() {
        const o = options(), sel = o.find(x => x.getAttribute('aria-selected') === 'true') || o[0];
        sel?.focus();
    }
    function onListKey(e) {
        const o = options(), at = o.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); o[Math.min(o.length - 1, at + 1)]?.focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); o[Math.max(0, at - 1)]?.focus(); }
        else if (e.key === 'Home') { e.preventDefault(); o[0]?.focus(); }
        else if (e.key === 'End') { e.preventDefault(); o[o.length - 1]?.focus(); }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const r = st.rows.find(x => String(x.version) === document.activeElement?.dataset.version); if (r) choose(r); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeList(true); }
    }

    // ── compare
    async function text(digest, signal) {
        const r = await fetch(serverUrl(artifactPath(digest), st.server), { signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
    }
    async function startCompare() {
        const i = cur(), row = st.rows[i], before = st.rows[i - 1];
        if (!TEXTY.test(row.media_type || '') && !/\.(md|markdown|txt|json|ya?ml|toml|csv|log)$/i.test(row.name || '')) { say('Compare is for text files.'); return; }
        dialog.classList.toggle('av-keep-wide', dialog.classList.contains('ac-on')); // the dialog keeps the width the version had with its comments: no jump on Compare
        st.comparing = true; st.sheetWas = hooks.sheetOpen(); if (st.sheetWas) hooks.setSheet(false); draw(); // a phone's open comments sheet would keep the document out of the keyboard's reach
        st.abort?.abort(); st.abort = new AbortController();
        const gen = ++st.gen, signal = st.abort.signal;
        try {
            const [a, b] = await Promise.all([text(before.digest, signal), text(row.digest, signal)]);
            if (gen !== st.gen || !st.comparing) return;
            const lines = diffLines(a, b);
            const body = hooks.body();
            dialog.classList.add('av-comparing');
            if (!lines) { body.replaceChildren(heading(row, before), el('p', 'av-note', 'These versions are too long to compare line by line.')); say('Too long to compare line by line.'); focusHeading(); return; }
            drawCompare(body, row, before, lines, true);
        } catch (e) {
            if (gen !== st.gen) return;
            st.comparing = false; draw();
            say(`Could not load the versions to compare: ${e.message || 'refused'}.`);
        }
    }
    const heading = (row, before) => { const h = el('h3', 'av-heading', `Changes since v${before.version}`); h.tabIndex = -1; return h; };
    const focusHeading = () => hooks.body().querySelector('.av-heading')?.focus();
    function drawCompare(body, row, before, lines, first = false) {
        const added = lines.filter(l => l.t === 'add').length, removed = lines.filter(l => l.t === 'del').length;
        const count = `${added} added, ${removed} removed`;
        const wrap = el('div', 'av-compare');
        const h = heading(row, before);
        const top = el('div', 'av-modebar');
        const status = el('p', 'av-count', count); // plain text: the one announcement is the polite line (a second live region would say it twice)
        const seg = el('div', 'av-seg btn-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Compare view');
        const bChanges = btn('av-view-changes', 'Changes'), bSplit = btn('av-view-split', 'Side by side');
        for (const [b, v] of [[bChanges, 'changes'], [bSplit, 'split']]) { b.setAttribute('aria-pressed', String(st.view === v)); b.addEventListener('click', () => { st.view = v; drawCompare(body, row, before, lines, false); body.querySelector(v === 'changes' ? '.av-view-changes' : '.av-view-split')?.focus(); }); }
        seg.append(bChanges, bSplit); top.append(status, seg);
        wrap.append(h, top);
        if (!added && !removed) wrap.append(el('p', 'av-note', `v${row.version} has the same text as v${before.version}.`));
        else wrap.append(st.view === 'changes' ? changesView(lines) : splitView(lines, row, before));
        body.replaceChildren(wrap);
        if (first) { say(`Changes since v${before.version}: ${count}`); h.focus(); } // said and shown once, when the compare opens, not on each switch of the view
    }
    function lineEl(l) {
        if (l.t === 'same') return el('div', 'av-line av-same', l.text || ' ');
        const tag = l.t === 'add' ? 'ins' : 'del';
        const d = el('div', l.t === 'add' ? 'av-line av-add' : 'av-line av-del'); const m = el(tag, '', l.text || ' '); d.append(sr(l.t === 'add' ? 'Added: ' : 'Removed: '), m);
        return d;
    }
    function changesView(lines) {
        const box = el('div', 'av-lines');
        const keep = new Array(lines.length).fill(false);
        lines.forEach((l, i) => { if (l.t !== 'same') for (let k = Math.max(0, i - CONTEXT); k <= Math.min(lines.length - 1, i + CONTEXT); k++) keep[k] = true; });
        // a run of one or two unchanged lines is shown, not folded into a note that costs as much as the lines
        for (let i = 0; i < lines.length;) {
            if (keep[i]) { i++; continue; }
            let j = i; while (j < lines.length && !keep[j]) j++;
            if (j - i < 3) for (let k = i; k < j; k++) keep[k] = true;
            i = j;
        }
        let skipped = 0;
        lines.forEach((l, i) => {
            if (!keep[i]) { skipped++; return; }
            if (skipped) { box.append(el('div', 'av-gap', `${skipped} unchanged lines not shown`)); skipped = 0; }
            box.append(lineEl(l));
        });
        if (skipped) box.append(el('div', 'av-gap', `${skipped} unchanged lines not shown`));
        return box;
    }
    function splitView(lines, row, before) {
        const grid = el('div', 'av-split');
        const left = el('div', 'av-col'), right = el('div', 'av-col');
        left.append(el('h4', 'av-colhead', `v${before.version} · ${whenOf(before.at).label}`));
        right.append(el('h4', 'av-colhead', `v${row.version} · ${whenOf(row.at).label}`));
        for (const l of lines) { if (l.t !== 'add') left.append(lineEl(l)); if (l.t !== 'del') right.append(lineEl(l)); }
        grid.append(left, right);
        return grid;
    }
    function leaveCompare() {
        st.comparing = false; st.gen++; st.abort?.abort();
        dialog.classList.remove('av-comparing', 'av-keep-wide');
        draw();
        hooks.reload(); // the version is drawn again, with its comments
        if (st.sheetWas) hooks.setSheet(true);
        st.sheetWas = false;
        const back = bar.querySelector('.av-compare'); (back && back.getClientRects().length ? back : bar.querySelector('.av-current'))?.focus(); // the list is closed: the keyboard is on the chip
    }

    return {
        /** A version of an artifact is on show: draw the bar when it is one of a series. `switched` says it was chosen from the bar (said once, and the keyboard stays on the bar). */
        async open(hex, server, { switched = false, board = '' } = {}) {
            st.gen++;
            clearInterval(liveTimer);
            liveTimer = pollEvery(refreshVersions, Number(globalThis.__coralVersionsPollMs) || 8000, { machine: () => st.server || '' });
            const scope = String(board || ''), scoped = st.rows && st.server === server && st.board === scope; // rows are another team's or computer's when either differs: never shown for this one
            const same = scoped && st.hex !== hex && st.rows.some(r => r.digest === hex);
            if (!scoped) st.rows = null;
            st.hex = hex; st.server = server; st.board = scope; st.listOpen = false; st.ambiguous = false;
            if (!switched) { st.comparing = false; dialog.classList.remove('av-comparing', 'av-keep-wide'); }
            if (!same && !(st.rows && st.rows.some(r => r.digest === hex))) { st.rows = null; draw(); const gen = st.gen, scopeNow = st.board; const res = await load(hex, server, scopeNow); if (gen !== st.gen || st.hex !== hex || st.server !== server || st.board !== scopeNow) return; st.rows = res.rows; st.ambiguous = res.ambiguous; }
            draw();
            if (switched && !bar.hidden) {
                const row = st.rows[cur()], w = whenOf(row.at);
                say(`Showing v${row.version} of ${st.rows.length}, ${w.label} (${w.full}), ${row.edited_in_dropbox ? 'edited in Dropbox' : (row.role || row.uploader || 'unknown')}`); // an edit made in Dropbox is said as such (#14714)
                bar.querySelector('.av-current')?.focus();
            }
        },
        close() { clearInterval(liveTimer); liveTimer = 0; st.gen++; st.abort?.abort(); st.rows = null; st.hex = null; st.comparing = false; st.listOpen = false; dialog.classList.remove('av-comparing', 'av-has-versions', 'av-keep-wide'); bar.hidden = true; bar.replaceChildren(); },
        comparing: () => st.comparing,
    };
}
