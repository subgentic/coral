// No module the dashboard loads at startup has a top-level await (#8538). A module graph with one finishes evaluating after the browser fired DOMContentLoaded
// (a deferred module does not hold that event for an awaiting graph), so a startup listener added at the end of evaluation can miss it: on a slower runner the agent
// pop-out never took its mode. A lazily loaded file may await (importOnce is its convention); one the entry imports statically may not.
//   node startup_no_tla.test.js
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const STATIC = path.resolve(__dirname, '../../coral-go/pkg/frontend/static');
const IMPORT = /^\s*(?:import\s+(?:[^'"]*?\sfrom\s+)?|export\s+(?:\*|\{[^}]*\})\s+from\s+)['"]\.\/([^'"]+)['"]/gm; // static imports and re-exports only: importOnce is not one

function topLevelAwait(src) {
    const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true });
    let found = null;
    (function walk(n, inFn) {
        if (!n || typeof n.type !== 'string' || found) return;
        if (n.type === 'AwaitExpression' && !inFn) { found = n; return; }
        const fn = inFn || /Function/.test(n.type);
        for (const k of Object.keys(n)) {
            const v = n[k];
            if (Array.isArray(v)) v.forEach(c => walk(c, fn)); else if (v && typeof v.type === 'string') walk(v, fn);
        }
    })(ast, false);
    return found && src.slice(0, found.start).split('\n').length;
}

const seen = new Set();
const problems = [];
(function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    let src;
    try { src = fs.readFileSync(path.join(STATIC, file), 'utf8'); } catch { return; }
    const line = topLevelAwait(src);
    if (line) problems.push(`${file}:${line} has a top-level await and is in the startup graph (import it statically, or load it lazily)`);
    for (const m of src.matchAll(IMPORT)) visit(m[1]);
})('app.js');

if (seen.size < 100) problems.push(`only ${seen.size} modules found from app.js: the walk is not reading the graph`);
if (problems.length) { console.error('FAIL startup graph:\n  ' + problems.join('\n  ')); process.exit(1); }
console.log(`PASS startup graph: ${seen.size} modules, no top-level await`);
