// Rendered markdown has one look, .prose (components.css, #9477): the heading scale (--prose-h1 to -h3), the spacing, the lists, the quotes, the code and the rules. Chat, the preview pane and a .md wear it, and their own classes say where the text sits
// and how it is themed. This census fails when
//   1. a rule makes a heading (h1 to h6 or .md-h) of some container look like something (font size, weight, margin) and the container is not .prose and not in BASELINE with its reason (the baseline only goes down: a container that no longer has
//      such a rule must come off it);
//   2. markup that draws the preview pane's markdown or a chat message's markdown has no .prose class.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'coral-go', 'pkg', 'frontend');
const walk = (dir, ext, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== 'vendor') walk(p, ext, out); } else if (ext.some(x => p.endsWith(x))) out.push(p); } return out; };

// the containers of rendered text that still have heading rules of their own, each for its reason: none (every container of rendered text wears .prose)
export const BASELINE = {};
const LOOK = /^(font-size|font-weight|margin(-[a-z]+)?|padding-bottom|border-bottom)$/;
const css = walk(path.join(root, 'static', 'css'), ['.css']).map(f => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
const problems = [], found = new Set();
for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const props = m[2].split(/;(?![^()]*\))/).map(d => d.split(':')[0].trim()).filter(Boolean);
    if (!props.some(p => LOOK.test(p))) continue;
    for (const raw of m[1].split(',')) {
        const parts = raw.trim().split(/[\s>+~]+/).filter(Boolean);
        const last = parts[parts.length - 1] || '';
        if (!/^(h[1-6]|\.md-h[1-6]?)$/.test(last.split(':')[0]) || parts.length < 2) continue;
        const owner = [...parts.slice(0, -1)].reverse().map(p => /\.([a-z][\w-]*)/.exec(p)).find(Boolean);
        if (!owner) continue;
        const cls = owner[1];
        if (cls === 'prose' || cls === 'prose-doc' || cls === 'prose-compact') continue; // .prose-doc is the document's two hairlines, part of the family
        // a heading of a chrome part (a dialog title, a page header, a card) is not rendered markdown: only the containers of rendered text are on the list
        if (!/(markdown|md$|prose|rendered|message-text|message-body|docs-content|plan|detail-md|content)/.test(cls)) continue;
        if (/^(modal|dialog|header|team-|cost-|cloud-|agent-ui|availability|hooks|servers|mb-actions|mb-view|template)/.test(cls) || cls === 'modal-content') continue;
        found.add(cls);
        if (!(cls in BASELINE)) problems.push(`css: "${raw.trim().replace(/\s+/g, ' ')}" makes a heading of rendered text look like something: use .prose, or list .${cls} in BASELINE with the reason`);
    }
}
for (const cls of Object.keys(BASELINE)) if (!found.has(cls)) problems.push(`baseline: .${cls} has no heading rule any more: take it off the list (the baseline only goes down)`);
for (const f of [...walk(path.join(root, 'static'), ['.js']), ...walk(path.join(root, 'templates'), ['.html'])]) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/class="([^"]*\bpreview-pane-markdown\b[^"]*)"/g)) if (!/(^|\s)prose(\s|$)/.test(m[1])) problems.push(`${path.relative(root, f)}: "${m[1]}" draws markdown without .prose`);
    for (const m of text.matchAll(/(?:class="|el\('div', ')([^"']*\b(?:notes-rendered|subagent-detail-md|cni-plan|mb-message-body)\b[^"']*)["']/g)) if (!/(^|\s)prose(\s|$)/.test(m[1])) problems.push(`${path.relative(root, f)}: "${m[1]}" draws markdown without .prose`);
    for (const m of text.matchAll(/class="([^"]*\bmessage-text\b[^"]*)">\$\{renderMarkdown\(/g)) if (!/(^|\s)prose(\s|$)/.test(m[1])) problems.push(`${path.relative(root, f)}: a chat message's markdown ("${m[1]}") has no .prose`);
}
if (!/\.prose h1(, \.prose \.md-h1)? \{[^}]*font-size: var\(--prose-h1\)/.test(css)) problems.push('css: the .prose heading scale is missing');
if (problems.length) { console.error('prose_census: FAIL\n  ' + [...new Set(problems)].join('\n  ')); process.exit(1); }
console.log(`prose_census: ok (.prose; ${Object.keys(BASELINE).length} containers of rendered text still have heading rules of their own)`);
