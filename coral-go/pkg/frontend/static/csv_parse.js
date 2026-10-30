/* A CSV and TSV parser (#11382), written for the artifact viewer's table and pure: no DOM, no reads, nothing but a string in and rows out, so a node test can feed it anything. RFC 4180: fields are separated
 * by the delimiter and records by CRLF, LF or CR; a field that begins with a quote is quoted, may hold the delimiter, line breaks and "" (one quote), and ends at the next lone quote; a quote in the middle
 * of an unquoted field is just a character. What the RFC leaves open is decided here and said: a BOM at the start is dropped; a blank line is no record; a line break inside quotes is kept as "\n" whatever it
 * was; text after a closing quote up to the delimiter is kept as it is; an unterminated quote runs to the end of the text; a short or long record is kept as it is (the table pads). It never throws and never
 * reads more than `maxChars` characters (a larger text is cut at its last whole line and `cut` says so), and it stores at most `maxRows` records while still counting the rest, and at most `maxCols` fields of a record while still counting its width. */

export const MAX_CHARS = 2 * 1024 * 1024; // the preview's own cap on text (artifact_preview.js)
export const MAX_ROWS = 5000;
export const MAX_COLS = 200;

/** Parses `text`. Returns { rows: string[][], total, cut, width }: the stored records (the first `maxRows`, each with at most `maxCols` fields), how many there were in all, whether the text was cut at `maxChars`, and the most fields any record had. */
export function parseDelimited(text, { delimiter = ',', maxRows = Infinity, maxChars = MAX_CHARS, maxCols = Infinity } = {}) {
    let s = typeof text === 'string' ? text : String(text == null ? '' : text);
    let cut = false;
    if (s.length > maxChars) {
        s = s.slice(0, maxChars);
        const nl = Math.max(s.lastIndexOf('\n'), s.lastIndexOf('\r'));
        if (nl > 0) s = s.slice(0, nl);
        cut = true;
    }
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    const delim = typeof delimiter === 'string' && delimiter.length === 1 && delimiter !== '"' && delimiter !== '\n' && delimiter !== '\r' ? delimiter : ',';
    const rows = [];
    let total = 0, row = [], count = 0, width = 0, field = '', quoted = false, inQuotes = false, fieldStart = true;
    const endField = () => { count++; if (row.length < maxCols) row.push(field.indexOf('\r') >= 0 ? field.replace(/\r\n?/g, '\n') : field); field = ''; quoted = false; fieldStart = true; };
    const endRow = () => {
        const blank = count === 0 && field === '' && !quoted; // nothing at all on the line
        if (!blank) {
            endField();
            total++;
            if (count > width) width = count;
            if (rows.length < maxRows) rows.push(row);
        }
        row = []; count = 0; field = ''; quoted = false; fieldStart = true;
    };
    for (let i = 0, n = s.length; i < n; i++) {
        const c = s[i];
        if (inQuotes) {
            if (c === '"') {
                if (s[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; fieldStart = false; }
            } else field += c;
            continue;
        }
        if (c === '"' && fieldStart) { inQuotes = true; quoted = true; fieldStart = false; continue; }
        if (c === delim) { endField(); continue; }
        if (c === '\n' || c === '\r') {
            if (c === '\r' && s[i + 1] === '\n') i++;
            endRow();
            continue;
        }
        field += c; fieldStart = false;
    }
    if (field !== '' || count || quoted || inQuotes) endRow(); // the last record, with or without a line break after it; an open quote ends here
    return { rows, total, cut, width };
}

/** The delimiter of a file: a tab for TSV; for CSV a semicolon when the header line has more of them than commas outside quotes (a European export), else a comma. */
export function delimiterFor(kind, text) {
    if (kind === 'tsv') return '\t';
    const head = String(text || '').slice(0, 4096).split(/\r\n|\n|\r/)[0] || '';
    let commas = 0, semis = 0, q = false;
    for (const ch of head) { if (ch === '"') q = !q; else if (!q) { if (ch === ',') commas++; else if (ch === ';') semis++; } }
    return semis > commas ? ';' : ',';
}

const NUMBER = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?%?$|^[-+]?\.\d+(?:[eE][-+]?\d+)?%?$/;

/** The number a cell says (1,234.5 and 12% included), or null when it is not one: a column of them sorts as numbers. */
export function numberOf(cell) {
    const t = String(cell == null ? '' : cell).trim();
    if (!NUMBER.test(t)) return null;
    const v = parseFloat(t.replace(/,/g, '').replace(/%$/, ''));
    return Number.isFinite(v) ? v : null;
}

/** Whether a column is numbers: at least 80% of its filled cells are (and one is). */
export function columnIsNumeric(rows, j) {
    let filled = 0, nums = 0;
    for (const r of rows) {
        const c = r[j];
        if (c == null || String(c).trim() === '') continue;
        filled++;
        if (numberOf(c) !== null) nums++;
    }
    return nums > 0 && nums >= filled * 0.8;
}
