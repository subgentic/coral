import fs from 'node:fs';
import assert from 'node:assert/strict';
import { installDom, importUi, STATIC } from '../../frontend/helpers/jsdom_env.mjs';
import { analyze, mapRenderedBlock, editRun, bytePatch } from './model.mjs';
const dom = installDom({ mode: 'local' });
dom.window.eval(fs.readFileSync(STATIC + 'vendor/marked.min.js', 'utf8')); globalThis.marked = dom.window.marked;
dom.window.eval(fs.readFileSync(STATIC + 'vendor/purify.min.js', 'utf8')); globalThis.DOMPurify = dom.window.DOMPurify;
const { renderMarkdownStrict } = await importUi('markdown');
export function inspect(source) {
    const model = analyze(source, marked), result = { blocks: model.blocks.length, candidates: 0, exact: 0, partial: 0, readonly: {}, probes: 0, supportedRuns: 0 };
    for (const block of model.blocks) {
        result.candidates += block.unitCount;
        const host = document.createElement('div'); host.innerHTML = renderMarkdownStrict(block.raw + '\n\n' + model.references);
        const map = block.reason ? { exact: false, entries: [] } : mapRenderedBlock(block, host);
        if (!map.exact) { const why = block.reason || 'Rendered node/token mismatch'; result.readonly[why] = (result.readonly[why] || 0) + (block.unitCount || 1); continue; }
        for (const unit of block.units) {
            const runs = block.runs.slice(unit.first, unit.first + unit.count);
            if (runs.length && runs.every(r => r.editable)) result.exact++;
            else if (runs.some(r => r.editable)) result.partial++;
        }
        for (const { run } of map.entries) {
            if (!run.editable) continue;
            result.supportedRuns++;
            const word = /[A-Za-z]{3,}/.exec(run.text); if (!word) continue;
            const at = word.index + word[0].length;
            const text = run.text.slice(0, at) + 'X' + run.text.slice(at);
            const changed = editRun(source, run, text), p = changed.patch;
            assert.equal(changed.source.slice(0, p.start), source.slice(0, p.start));
            assert.equal(changed.source.slice(p.start + p.inserted.length), source.slice(p.end));
            assert.equal(p.removed, ''); assert.equal(p.inserted, 'X');
            const bytes = bytePatch(source, changed.source);
            assert.equal(bytes.removedBytes, 0); assert.equal(bytes.insertedBytes, 1);
            assert.equal(bytes.offset, new TextEncoder().encode(source.slice(0, p.start)).length);
            assert.equal(new TextEncoder().encode(source).length, bytes.unchangedPrefixBytes + bytes.unchangedSuffixBytes);
            result.probes++;
        }
    }
    return result;
}
if (process.argv[2]) {
    const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const rows = manifest.map(row => { const raw = fs.readFileSync(row.file); const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); assert.deepEqual(Buffer.from(source, 'utf8'), raw, 'UTF-8 source including BOM is preserved'); return { uri: row.uri, sha256: row.sha256, linkedBy: row.producer, bytes: raw.length, ...inspect(source) }; });
    const total = rows.reduce((sum, row) => { for (const key of ['bytes','blocks','candidates','exact','partial','probes','supportedRuns']) sum[key] = (sum[key] || 0) + row[key]; for (const [key, n] of Object.entries(row.readonly)) sum.readonly[key] = (sum.readonly[key] || 0) + n; return sum; }, { documents: rows.length, readonly: {} });
    fs.writeFileSync('scratchpad/13728-measurement.json', JSON.stringify({ total, rows }, null, 2));
    console.log(JSON.stringify(total, null, 2));
}
