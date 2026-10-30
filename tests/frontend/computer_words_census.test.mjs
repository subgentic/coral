// One word for a linked Coral machine in the UI: "computer" (coral-hub's request, #11217: the Hub's pages and the docs say "Add a computer", "Computers"). A visible "server" or "machine" that means a
// linked Coral fails here. Every string a person can read (the page's string literals and the templates' text, titles, aria-labels and placeholders) is checked; routes, API fields, CSS classes, settings keys
// and test ids are not words and are not looked at (a hyphenated name like servers-page, an attribute value, a name with an underscore). What stays is listed below with why: the Coral process's own
// answers ("the server did not answer"), the tmux server, an MCP server, and the message board's server.
import * as acorn from 'acorn';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../coral-go/pkg/frontend');
const WORD = /(?<![\w-])(servers?|machines?)(?![\w-])/i;
// [file, text it must contain]: not a linked computer
const KEEP = [
    ['capture.js', 'capture poll: server not reachable'],            // a console line, not on screen
    ['mobile_connect.js', 'running server'],                          // this Coral's own process
    ['prerequisites.js', 'The server returned an invalid response'],  // this Coral's own answer
    ['settings_machine.js', 'this server build'],                     // this Coral's build
    ['task_detail_html.js', 'unless the server enables them'],        // this Coral
    ['task_detail_html.js', 'server check'],                          // a task's verification step
    ['settings_fields.js', 'tmux server'],                            // the tmux server
    ['terminal_backend.js', 'tmux server'],
    ['server_base.js', 'a server'],                                   // a developer error naming the proxy's base, never shown
    ['live_history.js', 'the reply from the server'],                 // this Coral's own answer
    ['saved_marks.js', 'the server sent a bookmark'],
    ['waiting.js', 'the server did not answer'],
];
const KEEP_TEMPLATE = ['MCP servers', 'Board Server', 'Lost connection to server', 'build server, test runner'];

const bad = [];
const attrless = s => s.replace(/\b(?:class|id|for|name|value|href|data-[\w-]+|aria-controls|aria-labelledby|type|role)=\\?["'][^"']*\\?["']/g, '');
const visible = t => { const x = attrless(t); return WORD.test(x) && (/\s/.test(x) || /^[A-Z]/.test(x)); };

const dir = path.join(root, 'static');
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const ast = acorn.parse(fs.readFileSync(path.join(dir, f), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true, locations: true });
    const walk = n => {
        if (!n || typeof n.type !== 'string') return;
        const text = n.type === 'Literal' && typeof n.value === 'string' ? n.value : n.type === 'TemplateElement' ? n.value.cooked : null;
        if (text && visible(text) && !KEEP.some(([kf, k]) => kf === f && text.includes(k))) bad.push(`static/${f}:${n.loc.start.line}: ${JSON.stringify(text).slice(0, 120)}`);
        for (const k in n) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); }
    };
    walk(ast);
}
const htmls = []; const scan = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) scan(p); else if (p.endsWith('.html')) htmls.push(p); } }; scan(path.join(root, 'templates'));
for (const f of htmls) {
    const s = fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' ')).replace(/<(script|style)[\s\S]*?<\/\1>/g, m => m.replace(/[^\n]/g, ' '));
    const parts = [];
    for (const m of s.matchAll(/(?:title|aria-label|placeholder|alt)="([^"]*)"/g)) parts.push([m.index, m[1]]);
    for (const m of s.matchAll(/>([^<>]+)</g)) parts.push([m.index, m[1]]);
    for (const [i, t] of parts) {
        if (!/[A-Za-z]/.test(t) || /\{\{/.test(t) && !/[A-Za-z]{3}/.test(t.replace(/\{\{[^}]*\}\}/g, ''))) continue;
        const plain = t.replace(/\{\{[^}]*\}\}/g, ' ');
        if (WORD.test(plain) && !KEEP_TEMPLATE.some(k => plain.includes(k))) bad.push(`${path.relative(root, f)}:${s.slice(0, i).split('\n').length}: ${JSON.stringify(plain.trim()).slice(0, 120)}`);
    }
}
if (bad.length) { console.error('computer_words_census FAIL: a visible "server" or "machine" for a linked Coral (say "computer"; or list it in KEEP with its reason):\n  ' + bad.join('\n  ')); process.exit(1); }
console.log('computer_words_census: ok');
