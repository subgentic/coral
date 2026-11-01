// A ghost tooltip over a preview (the operator, on the agent-tabs mockup in the preview pane: 'Preview of agent_tabs_mockup.html' floated over the page): an iframe's title is shown by the browser as a tooltip anywhere over its
// content, and the preview frames set one only to give the frame a name. The name is aria-label (the same accessible name, no tooltip). This fails on any iframe the dashboard builds or writes with a title.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const STATIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../coral-go/pkg/frontend/static');
const bad = [];
for (const f of fs.readdirSync(STATIC).filter(n => n.endsWith('.js'))) {
    const lines = fs.readFileSync(path.join(STATIC, f), 'utf8').split('\n');
    lines.forEach((ln, i) => {
        const code = ln.replace(/\/\/.*$/, '');
        if (/\b(frame|iframe|preview[A-Za-z]*Frame|[a-z]+Frame)\.title\s*=/.test(code) || /<iframe\b[^>]*\btitle=/.test(code)) bad.push(`${f}:${i + 1}: ${ln.trim().slice(0, 110)}`);
    });
}
assert.deepEqual(bad, [], 'an iframe is named with aria-label, not title (a title is a tooltip over its content):\n' + bad.join('\n'));
// the scan itself
const probe = s => /\b(frame|iframe|preview[A-Za-z]*Frame|[a-z]+Frame)\.title\s*=/.test(s) || /<iframe\b[^>]*\btitle=/.test(s);
assert.ok(probe("frame.title = 'x';") && probe('<iframe title="x">') && !probe("frame.setAttribute('aria-label', 'x');") && !probe("btn.title = 'x';"), 'the scan sees an iframe title and not another element\'s');
console.log('iframe_no_title_census: ok');
