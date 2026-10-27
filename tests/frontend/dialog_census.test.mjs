// The dialogs have three sizes by kind (#9185, Goal #84 step 5, spec item 6): a confirmation (--dlg-w-confirm, 28 rem), a short form (--dlg-w-form, 40 rem), a flow or settings
// (--dlg-w-flow, 60 rem, 640 high), and one radius (--dlg-radius). A dialog wears one of .dlg-confirm, .dlg-form, .dlg-flow; its width is nowhere else. This census fails on
//  1. a dialog in a template, or one a script builds, that has .modal-content and no size class (or two),
//  2. a rule that gives a dialog (.modal-content, a *-dialog, a *-modal) its own width, other than the three roles and the named ones below (a phone's 95vw, a max-width).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FE = path.join(HERE, '..', '..', 'coral-go', 'pkg', 'frontend');
const ROLES = ['dlg-confirm', 'dlg-form', 'dlg-flow'];
// a rule that sets a dialog's width on purpose, outside the roles: the selector (trimmed) and why
const OWN_WIDTH = {
    '.artifact-viewer.ac-on .artifact-viewer-content': 'the viewer widens when its comments are open: a viewer, not a dialog kind',
    '.artifact-viewer.av-keep-wide .artifact-viewer-content': 'the same, kept while the viewer stays open',
    '.board-choice-modal .modal-content': 'the board choice: a list of boards, not a form (width follows a 480 px list; to move to dlg-form with its census)',
};
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const bad = [], dialogClasses = new Set(['modal-content']);

// 1. every .modal-content in a template or a script has exactly one role
for (const f of [...walk(path.join(FE, 'templates')).filter(f => f.endsWith('.html')), ...fs.readdirSync(path.join(FE, 'static')).filter(f => f.endsWith('.js')).map(f => path.join(FE, 'static', f))]) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:class="|class=\\"|className = '|el\('div', '|mk\('[a-z]+', '|`)([^"'`\n]*(?<![.#\w-])modal-content\b[^"'`\n]*)(?:"|\\"|'|`)/g)) {
        const cls = m[1].split(/\s+/);
        if (!cls.includes('modal-content')) continue;
        for (const c of cls) dialogClasses.add(c);
        const n = ROLES.filter(r => cls.includes(r)).length;
        if (n !== 1) bad.push(`${path.relative(FE, f)}: "${m[1]}" has ${n} dialog size classes (one of ${ROLES.join(', ')})`);
    }
}

// 2. no other rule gives a dialog a width
for (const f of fs.readdirSync(path.join(FE, 'static', 'css')).filter(f => f.endsWith('.css'))) {
    const css = fs.readFileSync(path.join(FE, 'static', 'css', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const decl = m[2];
        if (!/(?:^|;)\s*width\s*:/.test(';' + decl)) continue; // width, not max-width or min-width
        if (/(?:^|;)\s*width\s*:\s*(?:100vw|100%|auto)\s*(?:!important)?\s*(?:;|$)/.test(';' + decl)) continue; // a phone's whole screen, or no width
        for (const raw of m[1].split(',')) {
            const sel = raw.trim().replace(/\s+/g, ' ');
            if (/!important/.test(decl) && /95vw|--dlg-max/.test(decl)) continue; // a phone's own rule (mobile.css)
            const last = sel.split(/[ >]+/).pop(); // the element itself, not a descendant of it
            const own = [...last.matchAll(/\.([\w-]+)/g)].map(x => x[1]);
            const dialogish = own.some(c => dialogClasses.has(c) || /-dialog$/.test(c)) && !own.some(c => /^dlg-/.test(c));
            if (dialogish && !OWN_WIDTH[sel] && !/--dlg-w-/.test(decl)) bad.push(`${f}: "${sel}" gives a dialog its own width (${decl.trim().replace(/\s+/g, ' ').slice(0, 60)}): wear a size class`);
        }
    }
}
for (const sel of Object.keys(OWN_WIDTH)) { /* named: a rule may go; nothing fails if it does */ }
assert.deepEqual(bad, [], 'the dialogs:\n  ' + bad.join('\n  '));
console.log('dialog_census: ok');
