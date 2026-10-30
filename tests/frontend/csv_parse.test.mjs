// The CSV and TSV parser of the artifact viewer's table (#11382): RFC 4180 by examples, the choices it makes where the RFC is silent, a round-trip fuzz (random tables written with proper quoting and random line
// endings must come back as they went in) and a garbage fuzz (random strings of the characters that matter never throw and always give clean records), and the caps.
import assert from 'node:assert/strict';
import { parseDelimited, delimiterFor, numberOf, columnIsNumeric, MAX_ROWS, MAX_COLS } from '../../coral-go/pkg/frontend/static/csv_parse.js';

const P = (t, o) => parseDelimited(t, o).rows;

// RFC 4180
assert.deepEqual(P('a,b,c\r\n1,2,3\r\n'), [['a', 'b', 'c'], ['1', '2', '3']]);
assert.deepEqual(P('a,b\n1,2'), [['a', 'b'], ['1', '2']], 'no line break after the last record');
assert.deepEqual(P('a,b\r1,2\r'), [['a', 'b'], ['1', '2']], 'a lone CR ends a record');
assert.deepEqual(P('"a,b",c'), [['a,b', 'c']], 'a comma inside quotes');
assert.deepEqual(P('"say ""hi""",x'), [['say "hi"', 'x']], 'a doubled quote is one quote');
assert.deepEqual(P('"line one\nline two",x'), [['line one\nline two', 'x']], 'a line break inside quotes');
assert.deepEqual(P('"crlf\r\ninside",x'), [['crlf\ninside', 'x']], 'CRLF inside quotes is one \\n');
assert.deepEqual(P('a,,c'), [['a', '', 'c']], 'an empty field');
assert.deepEqual(P('a,'), [['a', '']], 'a trailing delimiter is an empty last field');
assert.deepEqual(P(',a'), [['', 'a']]);
assert.deepEqual(P('""'), [['']], 'a quoted empty field is a record');
assert.deepEqual(P('a,"",b'), [['a', '', 'b']]);

// what the RFC leaves open
assert.deepEqual(P('﻿a,b\n1,2'), [['a', 'b'], ['1', '2']], 'a BOM is dropped');
assert.deepEqual(P('a\n\n\nb\n'), [['a'], ['b']], 'a blank line is no record');
assert.deepEqual(P('a,b\n1'), [['a', 'b'], ['1']], 'a short record is kept as it is');
assert.deepEqual(P('a\n1,2,3'), [['a'], ['1', '2', '3']], 'so is a long one');
assert.deepEqual(P('ab"cd,e'), [['ab"cd', 'e']], 'a quote in the middle of a field is a character');
assert.deepEqual(P('"ab"cd,e'), [['abcd', 'e']], 'text after a closing quote is kept');
assert.deepEqual(P('a,"never closed\nstill in it'), [['a', 'never closed\nstill in it']], 'an unterminated quote runs to the end');
assert.deepEqual(P(''), []);
assert.deepEqual(P('\n\r\n'), []);
assert.deepEqual(P('   '), [['   ']], 'spaces are a field');
assert.deepEqual(P('a;b\n1;2', { delimiter: ';' }), [['a', 'b'], ['1', '2']]);
assert.deepEqual(P('a\tb\n"x\ty"\tz', { delimiter: '\t' }), [['a', 'b'], ['x\ty', 'z']], 'TSV with a tab inside quotes');
assert.deepEqual(P('a,b', { delimiter: '"' }), [['a', 'b']], 'a delimiter that cannot be one falls back to a comma');
assert.deepEqual(P('=HYPERLINK("http://x"),+1,-2,@SUM(A1)'), [['=HYPERLINK("http://x")', '+1', '-2', '@SUM(A1)']], 'a formula-looking cell is text as written');
assert.deepEqual(P('<b>x</b>,<img src=x onerror=alert(1)>'), [['<b>x</b>', '<img src=x onerror=alert(1)>']], 'markup is just characters here (the table sets text)');

// the delimiter of a file
assert.equal(delimiterFor('tsv', 'a,b'), '\t');
assert.equal(delimiterFor('csv', 'a,b,c\n1,2,3'), ',');
assert.equal(delimiterFor('csv', 'a;b;c\n1;2;3'), ';');
assert.equal(delimiterFor('csv', '"a;b;c",d\n1,2'), ',', 'semicolons inside quotes do not count');
assert.equal(delimiterFor('csv', ''), ',');

// numbers
assert.equal(numberOf('42'), 42); assert.equal(numberOf(' -3.5 '), -3.5); assert.equal(numberOf('1,234.5'), 1234.5); assert.equal(numberOf('12%'), 12); assert.equal(numberOf('.5'), 0.5); assert.equal(numberOf('1e3'), 1000);
for (const bad of ['', 'abc', '12abc', '1,2', '--1', '1.', '$5', '0x10', 'NaN', 'Infinity']) assert.equal(numberOf(bad), null, JSON.stringify(bad));
assert.equal(columnIsNumeric([['1'], ['2'], ['x'], ['4'], ['5']], 0), true, '4 of 5 filled cells are numbers');
assert.equal(columnIsNumeric([['1'], ['x'], ['y']], 0), false);
assert.equal(columnIsNumeric([[''], ['']], 0), false, 'an empty column is not numeric');

// the caps
const big = Array.from({ length: MAX_ROWS + 50 }, (_, i) => `r${i},${i}`).join('\n');
const capped = parseDelimited(big, { maxRows: MAX_ROWS });
assert.equal(capped.rows.length, MAX_ROWS, 'only the first maxRows are stored');
assert.equal(capped.total, MAX_ROWS + 50, 'and the rest are counted');
assert.equal(capped.cut, false);
const long = 'a,b\n' + 'x,y\n'.repeat(1000);
const cutText = parseDelimited(long, { maxChars: 100 });
assert.equal(cutText.cut, true, 'a text over the character cap is cut');
assert.ok(cutText.rows.every(r => r.length === 2 && r[0] !== undefined), 'at a whole line');
assert.ok(cutText.rows.length <= 100 / 4 + 1);

// the column cap: a record keeps its first maxCols fields and still says how wide it was
const wide = parseDelimited(Array.from({ length: 1000 }, (_, i) => i).join(',') + '\n1,2', { maxCols: MAX_COLS });
assert.equal(wide.rows[0].length, MAX_COLS); assert.equal(wide.width, 1000); assert.equal(wide.rows[1].length, 2); assert.equal(wide.total, 2);
assert.deepEqual(wide.rows[0].slice(-1), [String(MAX_COLS - 1)]);
// a 2 MB single record of commas: no throw, capped, counted, and fast
const t0 = Date.now();
const commas = parseDelimited(','.repeat(2 * 1024 * 1024), { maxCols: MAX_COLS, maxRows: MAX_ROWS });
assert.equal(commas.rows.length, 1); assert.equal(commas.rows[0].length, MAX_COLS); assert.ok(commas.width > 2 * 1024 * 1024 - 10, 'its true width is counted');
assert.ok(Date.now() - t0 < 1000, `a 2 MB record of commas parses in under a second (${Date.now() - t0} ms)`);
// 5,000 records of 400 fields: capped to 200 fields each
const grid = Array.from({ length: 5000 }, () => 'x,'.repeat(399) + 'x').join('\n');
const g = parseDelimited(grid, { maxCols: MAX_COLS, maxRows: MAX_ROWS });
assert.ok(g.rows.every(r => r.length <= MAX_COLS) && g.width === 400);

// a deterministic generator (a small LCG), so a failure is the same every run
let seed = 20261030;
const rnd = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
const PIECES = ['a', 'b', 'Z', '0', '42', ' ', ',', ';', '"', '""', '\n', '\r\n', '\r', '\t', '=', '+', '@', '-', '<', '&', 'é', '名', '\u0000', '​', "'", '\\'];
const randomField = () => { let f = ''; for (let k = rnd(7); k > 0; k--) f += PIECES[rnd(PIECES.length)]; return f; };
const writeCsv = (rows, delim, eol, always) => rows.map(r => (r.length === 1 && r[0] === '' ? '""' : r.map(f => (always || /["\r\n]/.test(f) || f.includes(delim) || f === '' && r.length === 1 ? `"${f.replace(/"/g, '""')}"` : f)).join(delim))).join(eol) + (rnd(2) ? eol : '');

// round trip: what was written comes back, with line breaks in a field as "\n"
for (let n = 0; n < 3000; n++) {
    const cols = 1 + rnd(5), rows = Array.from({ length: 1 + rnd(6) }, () => Array.from({ length: cols }, randomField));
    const delim = [',', ';', '\t'][rnd(3)], eol = ['\n', '\r\n', '\r'][rnd(3)];
    const text = writeCsv(rows, delim, eol, rnd(2) === 0);
    const want = rows.map(r => r.map(f => f.replace(/\r\n?/g, '\n')));
    const got = parseDelimited(text, { delimiter: delim }).rows;
    assert.deepEqual(got, want, `round trip #${n}: ${JSON.stringify(text)}`);
}

// garbage: random strings of the characters that matter never throw, and every record is a list of strings with no CR in it
for (let n = 0; n < 5000; n++) {
    let t = ''; for (let k = rnd(40); k > 0; k--) t += PIECES[rnd(PIECES.length)];
    for (const delimiter of [',', '\t', ';']) {
        const r = parseDelimited(t, { delimiter });
        assert.ok(Array.isArray(r.rows) && r.total >= r.rows.length, `garbage #${n}`);
        for (const row of r.rows) { assert.ok(Array.isArray(row) && row.length >= 1, `garbage #${n} record`); for (const f of row) assert.ok(typeof f === 'string' && !f.includes('\r'), `garbage #${n} field`); }
    }
}
// not a string at all
for (const v of [null, undefined, 42, {}, []]) assert.doesNotThrow(() => parseDelimited(v));
console.log('csv_parse: RFC 4180, the open choices, the caps, 3000 round trips and 5000 garbage strings ok');
