// classList.add, remove and toggle take one class per argument: a string with a space in it ("field sched-tz-input") throws InvalidCharacterError at run time, and the code after it (a form's setup) never runs. A script that
// writes a space inside a classList token fails here, so the next one is caught before a browser finds it (#9295: the job form's Time zone setup).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STATIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'coral-go', 'pkg', 'frontend', 'static');
const CALL = /\.classList\s*\.\s*(add|remove|toggle|contains)\s*\(\s*(['"`])([^'"`]*?)\2/g;

export function spaced(src) {
    const out = [];
    for (const m of src.matchAll(CALL)) if (/\s/.test(m[3].trim())) out.push(`${m[1]}(${m[2]}${m[3]}${m[2]})`);
    return out;
}
assert.deepEqual(spaced("a.classList.add('x y'); b.classList.toggle(\"p\", on); c.classList.add('a', 'b b'); d.classList.contains('ok');"), ["add('x y')"], 'a space inside the first token; a second argument is not read');
const bad = [];
for (const f of fs.readdirSync(STATIC).filter(n => n.endsWith('.js')).sort()) for (const s of spaced(fs.readFileSync(path.join(STATIC, f), 'utf8'))) bad.push(`${f}: classList.${s}: one class per argument`);
assert.deepEqual(bad, [], 'classList tokens');
console.log('class_list_tokens: ok (no classList call in static/*.js holds a space in a class token)');
