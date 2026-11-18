// A step's status and exit code come from a run's record (a Hub or a script can write anything): the run timeline escapes both, as text and in class attributes (coral-hub report, #19557).
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
globalThis.location = { protocol: 'http:', host: 'x', search: '' };
const here = path.dirname(fileURLToPath(import.meta.url));
const { runStepHtml } = await import(pathToFileURL(path.resolve(here, '../../coral-go/pkg/frontend/static/workflow_run_html.js')).href);
const hostile = '"><img src=x onerror=window.__pwn=1>';
const html = runStepHtml({ status: 'running' }, { type: 'shell', name: 'build', status: hostile, exit_code: hostile }, 0, 1);
assert.ok(!html.includes('<img'), 'no markup from a status or an exit code survives: ' + html.slice(0, 300));
assert.ok(html.includes('&quot;&gt;&lt;img'), 'the hostile text is in the page as text, quotes and brackets escaped');
const ok = runStepHtml({ status: 'running' }, { type: 'shell', name: 'build', status: 'failed', exit_code: 2 }, 0, 1);
assert.match(ok, /exit 2/); assert.match(ok, /wf-exit-err/); assert.match(ok, /wf-run-step-status failed/);
console.log('workflow_run_escape: ok');
