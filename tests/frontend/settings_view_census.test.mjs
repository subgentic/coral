// The census that keeps settings_view the one place a settings row is styled (#7744: "it should make it easier to apply styling changes to the app"):
//  (a) no stylesheet other than settings_view.css styles a .sv selector, and every selector of settings_view.css is under .sv (the shared nav shell only as ".sv .settings-*");
//  (b) a RATCHET on the legacy row classes (the markup each surface drew its own rows with before the component): the number of CSS selectors, script mentions and template mentions of each may only
//      fall; a surface that adds a row class, or a new one of the same families, fails here. Each conversion lowers the baseline (node settings_view_census.test.mjs --update) in its own commit;
//  (c) the --sv-* tokens: every one settings_view.css reads is defined in variables.css, and every one defined is read;
//  (d) the one fold breakpoint (a container query, since a variable cannot hold it) is written once, in settings_view.css.
// Run on its own: node settings_view_census.test.mjs [--update]
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fe = path.resolve(here, '../../coral-go/pkg/frontend');
const read = p => fs.readFileSync(p, 'utf8');
const strip = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const files = (d, ext) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => { const p = path.join(d, e.name); return e.isDirectory() ? (['vendor', 'node_modules'].includes(e.name) ? [] : files(p, ext)) : ext.some(x => p.endsWith(x)) ? [p] : []; });
const cssFiles = files(path.join(fe, 'static/css'), ['.css']);
const jsFiles = files(path.join(fe, 'static'), ['.js']).filter(f => !f.includes('/vendor/'));
const tplFiles = files(path.join(fe, 'templates'), ['.html']);
const SV_CSS = path.join(fe, 'static/css/settings_view.css');

/** The selectors of a stylesheet (the text before each "{" outside a declaration block, nested at-rules included). */
function selectorsOf(css) {
    const out = []; let depth = 0, start = 0;
    const text = strip(css);
    const stack = [];
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '{') {
            const head = text.slice(start, i).trim();
            if (head && !head.startsWith('@')) { if (!stack.includes('decl')) out.push(head); stack.push('rule'); }
            else stack.push(head.startsWith('@keyframes') || head.startsWith('@font-face') ? 'decl' : 'at');
            start = i + 1; depth++;
        } else if (c === '}') { stack.pop(); start = i + 1; depth--; }
        else if (c === ';' && stack[stack.length - 1] === 'at') start = i + 1;
    }
    return out.flatMap(s => s.split(',').map(x => x.trim()).filter(Boolean));
}

// (a)
const sv = selectorsOf(read(SV_CSS));
const outside = sv.filter(s => !/(^|[\s>+~(])\.sv\b/.test(s) && !/^:root/.test(s));
assert.deepEqual(outside, [], 'every selector of settings_view.css is under .sv: ' + outside.join(' | '));
const leaks = [];
for (const f of cssFiles) {
    if (f === SV_CSS) continue;
    for (const s of selectorsOf(read(f))) if (/\.sv(-|\b)/.test(s)) leaks.push(`${path.basename(f)}: ${s}`);
}
assert.deepEqual(leaks, [], 'no other stylesheet styles a .sv selector (a surface changes a token or the rule in settings_view.css): ' + leaks.join(' | '));

// (b) the legacy row classes
const LEGACY = ['settings-row', 'settings-cli-row', 'tb-row', 'settings-row-switch', 'settings-unit-field', 'settings-inline', 'settings-api-key-row',
    'ts-row', 'working-mode-form', 'health-row', 'health-line', 'health-form', 'workflow-mode-line', 'preset-name-field', 'launch-prompt-field', 'job-field', 'job-limit-fields'];
// Shared controls that are NOT legacy rows and stay their own component (#8460, Goal #54 item e): pw-input-row is the password field with its Show button beside it, one control (password_ui.js)
// used by the sign-in page and the set-password dialog (auth_page.go) and by Settings' Security group (the Change password fields). It is a control inside a row, not a row, so it is not counted
// down to zero; it is named here so the families check below does not read it as a new settings-style row.
const SHARED_CONTROLS = ['pw-input-row'];
const FAMILY = /^(settings|ts|launch|job|health|working-mode|workflow-mode|preset|pw|tb|net)-[a-z-]*(row|field|line|form|inline|head|fields)$/;
const count = (list, cls) => list.reduce((n, f) => n + (read(f).match(new RegExp(`(?<![\\w-])${cls.replace(/[-]/g, '\\-')}(?![\\w-])`, 'g')) || []).length, 0);
const cssSel = cls => cssFiles.reduce((n, f) => n + selectorsOf(read(f)).filter(s => new RegExp(`\\.${cls}(?![\\w-])`).test(s)).length, 0);
const nowCounts = {};
for (const c of LEGACY) nowCounts[c] = { css: cssSel(c), js: count(jsFiles, c), html: count(tplFiles, c) };
// launch-field-* is a prefix family
nowCounts['launch-field-*'] = { css: cssFiles.reduce((n, f) => n + selectorsOf(read(f)).filter(s => /\.launch-field-[a-z]/.test(s)).length, 0), js: jsFiles.reduce((n, f) => n + (read(f).match(/launch-field-[a-z]/g) || []).length, 0), html: tplFiles.reduce((n, f) => n + (read(f).match(/launch-field-[a-z]/g) || []).length, 0) };
const baselinePath = path.join(here, 'fixtures/settings_view_baseline.json');
if (process.argv.includes('--update')) { fs.writeFileSync(baselinePath, JSON.stringify(nowCounts, null, 2) + '\n'); console.log('wrote ' + baselinePath); }
const baseline = JSON.parse(read(baselinePath));
const up = [], down = [];
for (const [c, now] of Object.entries(nowCounts)) {
    const was = baseline[c];
    if (!was) { up.push(`${c}: not in the baseline`); continue; }
    for (const k of ['css', 'js', 'html']) { if (now[k] > was[k]) up.push(`${c} (${k}): ${was[k]} -> ${now[k]}`); else if (now[k] < was[k]) down.push(`${c} (${k}): ${was[k]} -> ${now[k]}`); }
}
assert.deepEqual(up, [], 'a legacy settings row class grew: draw the row with settings_view (mountSettingsView), do not add a row class: ' + up.join('; '));
// a NEW class of the same families anywhere in the scripts and templates (the ones that exist today are listed in the baseline's __families)
const known = new Set([...LEGACY, ...SHARED_CONTROLS, ...Object.keys(baseline).filter(k => k !== '__families'), ...(baseline.__families || [])]);
const fresh = new Set();
for (const f of [...jsFiles, ...tplFiles]) for (const m of read(f).matchAll(/class(?:Name)?\s*=\s*["'`]([^"'`]*)["'`]/g)) for (const c of m[1].split(/\s+/)) if (FAMILY.test(c) && !/\$\{/.test(c)) fresh.add(c);
if (process.argv.includes('--update')) { baseline.__families = [...fresh].sort(); fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n'); }
else assert.deepEqual([...fresh].filter(c => !known.has(c)), [], 'a new settings-style row class appeared (the families settings-, ts-, launch-, job-, health-, working-mode-, preset-, pw-, tb-, net- ... -row/-field/-line/-form/-head): use settings_view');

// (c) tokens
const svCss = strip(read(SV_CSS)), vars = strip(read(path.join(fe, 'static/css/variables.css')));
const used = new Set([...svCss.matchAll(/var\((--sv-[a-z0-9-]+)/g)].map(m => m[1]));
const defined = new Set([...vars.matchAll(/(--sv-[a-z0-9-]+)\s*:/g)].map(m => m[1]));
assert.deepEqual([...used].filter(t => !defined.has(t)), [], 'a --sv- token settings_view.css reads is not defined in variables.css');
assert.deepEqual([...defined].filter(t => !used.has(t)), [], 'a --sv- token variables.css defines is never read by settings_view.css');

// (d) the one fold breakpoint
const folds = [...svCss.matchAll(/@container\s+sv\s*\(max-width:\s*([0-9.]+rem)\)/g)];
assert.deepEqual(folds.map(f => f[1]), ['50rem', '40rem', '24rem'], 'three container breakpoints in settings_view.css: the fold with a nav (50rem), the fold of rows alone (40rem, the main Settings\' own) and the narrow view that scrolls whole (24rem); found ' + folds.map(f => f[1]).join(', '));
for (const f of cssFiles) if (f !== SV_CSS) assert.ok(!/@container\s+sv\b/.test(strip(read(f))), `${path.basename(f)} writes a second fold for the component`);

console.log(`settings_view_census: ok (a .sv block only in settings_view.css, ${Object.keys(nowCounts).length} legacy row classes only falling${down.length ? ', ' + down.length + ' fell: run --update to lower the baseline' : ''}, ${defined.size} tokens used, one fold at ${folds[0][1]})`);
