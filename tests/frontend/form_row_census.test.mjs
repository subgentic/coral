// One form row (Goal #84, spec item 7): a form field is the settings_view row (label above, control, hint) or the hand-built row that writes the same classes (.form-row, .form-label,
// .form-control-*, .form-check in components.css, and .settings-hint for the hint), never a style attribute of its own. This census reads every template and script: a <label>, <input>, <select> or <textarea>
// with a style attribute that sets anything but display:none (a field a script shows later) fails. Write the look in a class (a new one in components.css when the row needs it).
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fe = path.resolve(here, '../../coral-go/pkg/frontend');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? (['vendor', 'node_modules', 'agent_docs'].includes(e.name) ? [] : walk(p)) : [p];
});
const FIELD = /<(label|input|select|textarea)\b[^>]*?\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

export function scan(files = walk(fe).filter(f => /\.(html|js)$/.test(f))) {
    const out = [];
    for (const f of files) {
        const text = fs.readFileSync(f, 'utf8');
        for (const m of text.matchAll(FIELD)) {
            const style = (m[2] ?? m[3]).trim().replace(/;$/, '').replace(/\s+/g, '');
            if (style === 'display:none') continue;
            const line = text.slice(0, m.index).split('\n').length;
            out.push(`${path.relative(fe, f)}:${line}: <${m[1]}> has style="${style.slice(0, 60)}": write a class (.form-label, .form-control-*, ... in components.css)`);
        }
    }
    return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const css = fs.readFileSync(path.join(fe, 'static/css/components.css'), 'utf8');
    for (const c of ['.form-row', '.form-label', '.form-control-full', '.form-check']) assert.ok(css.includes(c + ' ') || css.includes(c + ','), `components.css defines ${c}`);
    // the scan can fail: a styled field, a styled label with a quote style, and an allowed display:none
    const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'frc-'));
    try {
        const f = path.join(tmp, 'x.html');
        fs.writeFileSync(f, `<label style="margin:0">a</label> <input type='text' style='width:100%'> <select style="display:none;"></select> <textarea class="a"></textarea>`);
        const got = scan([f]);
        assert.equal(got.length, 2, 'finds the styled label and the styled input, not display:none: ' + JSON.stringify(got));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    const problems = scan();
    assert.deepEqual(problems, [], `form fields with a style attribute:\n  ${problems.join('\n  ')}`);
    console.log('form_row_census: ok');
}
