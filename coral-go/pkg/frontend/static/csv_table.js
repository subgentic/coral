/* A CSV or TSV artifact as a table (#11382), loaded by the preview renderer only for such a file. The first record is the header (sticky); a click on a header sorts (a column of numbers as numbers, the rest as
 * text, ties in file order); a box filters the rows; a long cell is cut to a few lines with a button that shows all of it; the table scrolls inside its own box, never the page; Raw shows the original text and
 * Table brings the table back (Download is the host's and is unchanged). Every cell is set as text, never as HTML, and a cell that begins with = + - or @ is shown as written: nothing here is a spreadsheet and
 * nothing is exported to one. At most 5,000 records are drawn (the status says "of" how many there are) and at most 2 MB of text is read, so a huge file cannot freeze the page. */
import { importOnce } from './import_once.js';
import { loadStyles } from './lazy_styles.js';
const { parseDelimited, delimiterFor, numberOf, columnIsNumeric, MAX_ROWS, MAX_CHARS } = await importOnce('./csv_parse.js'); // lazy: its failure is retried
const DT = await importOnce('./data_table.js'); // the one table (#7743)
await loadStyles('csv_table.css');
const { el } = DT;

const CLAMP = 240; // characters a cell shows before its "Show all"
const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/** A cell: its text (textContent), cut to a few lines when it is long, with a button that shows the rest. */
function cellNode(text) {
    if (text.length <= CLAMP) return text;
    const wrap = el('span', 'csv-long');
    const t = el('span', 'csv-clamp', text);
    const b = el('button', 'btn btn-small csv-more', 'Show all'); b.type = 'button'; b.setAttribute('aria-expanded', 'false');
    b.addEventListener('click', e => { e.stopPropagation(); const open = t.classList.toggle('csv-clamp-open'); b.textContent = open ? 'Show less' : 'Show all'; b.setAttribute('aria-expanded', String(open)); });
    wrap.append(t, b);
    return wrap;
}

/** Draws the table of `content` into `body`. opts: { name, tsv, raw(host) } where raw draws the original text into the host it is given (the host's own text renderer). */
export function renderCsvTable(body, content, opts = {}) {
    const kind = opts.tsv ? 'tsv' : 'csv';
    const parsed = parseDelimited(content, { delimiter: delimiterFor(kind, content), maxRows: MAX_ROWS + 1, maxChars: MAX_CHARS }); // the header and MAX_ROWS records
    const head = parsed.rows[0] || [];
    const data = parsed.rows.slice(1).map((cells, i) => ({ i, cells }));
    const totalData = Math.max(0, parsed.total - 1);
    const width = Math.max(head.length, ...data.map(r => r.cells.length), 1);
    const labels = Array.from({ length: width }, (_, j) => (head[j] || '').trim() || `Column ${j + 1}`);
    const numeric = labels.map((_, j) => columnIsNumeric(data.map(r => r.cells), j));
    const columns = labels.map((label, j) => ({
        key: `c${j}`, label, width: '11rem', nowrap: false, numeric: numeric[j], align: numeric[j] ? 'end' : 'start',
        sort: numeric[j] ? 'number' : true,
        sortValue: r => (numeric[j] ? (numberOf(r.cells[j]) ?? Number.NEGATIVE_INFINITY) : String(r.cells[j] ?? '').toLowerCase()),
        cell: r => cellNode(String(r.cells[j] ?? '')),
    }));
    const state = DT.tableState();
    const hay = new Map(); // a row's text, lower-cased, made once
    const haystack = r => { let h = hay.get(r.i); if (h === undefined) { h = r.cells.join('\n').toLowerCase(); hay.set(r.i, h); } return h; };

    const view = el('div', 'csv-view');
    const bar = el('div', 'csv-controls');
    const seg = el('div', 'btn-seg csv-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'View');
    const tableBtn = el('button', 'btn', 'Table'), rawBtn = el('button', 'btn', 'Raw');
    for (const b of [tableBtn, rawBtn]) b.type = 'button';
    seg.append(tableBtn, rawBtn);
    const filter = el('input', 'field field-dense csv-filter'); filter.type = 'search'; filter.placeholder = 'Filter rows'; filter.setAttribute('aria-label', 'Filter rows'); filter.autocomplete = 'off';
    bar.append(seg, filter);
    const status = el('p', 'csv-status'); status.setAttribute('role', 'status');
    const scroll = el('div', 'csv-scroll');
    const rawHost = el('div', 'csv-raw'); rawHost.hidden = true;
    view.append(bar, status, scroll, rawHost);
    body.replaceChildren(view);

    let q = '', mode = 'table', rawDrawn = false;
    function draw() {
        const rows = q ? data.filter(r => haystack(r).includes(q)) : data;
        const cap = totalData > data.length || parsed.cut;
        status.textContent = !data.length ? 'No rows below the header.'
            : q ? `${rows.length.toLocaleString('en-US')} of ${plural(data.length, 'row')} match${rows.length === 1 ? 'es' : ''}${cap ? ` (the first ${data.length.toLocaleString('en-US')} of ${totalData.toLocaleString('en-US')}${parsed.cut ? '+' : ''})` : ''}.`
                : cap ? `Showing ${data.length.toLocaleString('en-US')} of ${totalData.toLocaleString('en-US')}${parsed.cut ? '+' : ''} rows${parsed.cut ? ' (the file is larger than the 2 MB read)' : ''}.`
                    : plural(data.length, 'row') + '.';
        const t = DT.dataTable({ label: opts.name || 'Table', columns, rows, rowKey: r => r.i, fold: 'none', scroll: true, state, empty: { line: q ? 'No row has that text.' : 'No rows below the header.' } });
        t.el.style.maxHeight = 'min(70vh, 40rem)'; // the table's own box scrolls both ways, so its header sticks to the top of it and the page never scrolls sideways
        scroll.replaceChildren(t.el);
    }
    function show(next) {
        mode = next;
        tableBtn.setAttribute('aria-pressed', String(next === 'table')); rawBtn.setAttribute('aria-pressed', String(next === 'raw'));
        const isTable = next === 'table';
        scroll.hidden = !isTable; filter.hidden = !isTable; status.hidden = !isTable; rawHost.hidden = isTable;
        if (!isTable && !rawDrawn) { rawDrawn = true; if (typeof opts.raw === 'function') opts.raw(rawHost); else rawHost.textContent = content; }
    }
    tableBtn.addEventListener('click', () => show('table'));
    rawBtn.addEventListener('click', () => show('raw'));
    let timer = 0;
    filter.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { q = filter.value.trim().toLowerCase(); draw(); }, 120); });
    draw(); show('table');
    return { view, get mode() { return mode; } };
}
