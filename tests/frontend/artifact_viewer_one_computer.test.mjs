// #13837: an artifact viewer opened with no server named, in a Hub context with a remote computer selected, must ask ONE computer for everything: the file, its comments, its versions and readers,
// and the Edit and Send capabilities (whose save and send go to the same place). At 1257a1fcb the file and the comments fell back to the selected computer (contextServer()) while the versions, the team's
// file list, the readers and editContext(opts.server) went to the Hub's own route, so a document from ws1 was edited and sent against the local computer's board of the same name.
// Registered in cloud_checks.txt, and RED until the viewer is fixed (failing-first): the fix goes on top of this commit; do not merge this commit alone.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { installDom, importUi, STATIC } from './helpers/jsdom_env.mjs';
const dom=installDom({mode:'local'});dom.window.eval(fs.readFileSync(STATIC+'vendor/marked.min.js','utf8'));globalThis.marked=dom.window.marked;dom.window.eval(fs.readFileSync(STATIC+'vendor/purify.min.js','utf8'));globalThis.DOMPurify=dom.window.DOMPurify;
const hex='a'.repeat(64),base='b'.repeat(64);let calls=[];
globalThis.fetch=window.fetch=async(url,options={})=>{calls.push({url:String(url),...options});const p=new URL(String(url),location.href).pathname;if(p.endsWith('/edit/send'))return Response.json({can_send_edit:true,base_digest:base,base_version:1,version:2,sent_to:[]});if(p.endsWith('/edit'))return Response.json({can_edit:true});if(/\/api\/artifacts\/[a-f0-9]{64}$/.test(p)||/\/api\/remote\/ws1\/api\/artifacts\/[a-f0-9]{64}$/.test(p))return new Response('# Report\n\nSaved words.\n',{headers:{'Content-Type':'text/markdown','Content-Disposition':'attachment; filename="report.md"'}});return new Response('',{status:404});};
const viewer=await importUi('artifact_viewer');
const { state } = await importUi('state');
// which computer a request went to: the prefix of the route
const computerOf = url => { const m = /^\/api\/remote\/([^/]+)\//.exec(new URL(url, location.href).pathname); return m ? m[1] : 'local'; };
const asked = () => calls.filter(c => !/\/api\/(saved|board\/projects)/.test(c.url)).map(c => `${computerOf(c.url)} ${new URL(c.url, location.href).pathname.replace(hex, '<hex>')}`);
for (const [label, opts] of [['no board and no server named', {}], ['a board named and no server', { board: 'dev' }]]) test(`one computer for the whole viewer: ${label}, ws1 selected`, async () => {
 state.selectedTeam = '@ws1/dev'; calls = [];
 try {
  viewer.openArtifactViewer(hex, { ...opts, filename: 'report.md', editSaved: true });
  await new Promise(r => setTimeout(r, 600));
  assert.ok(calls.some(c => /\/edit\/send$/.test(c.url)) && calls.some(c => /\/edit$/.test(c.url)), 'the Edit and Send capabilities were asked: ' + asked().join(' | '));
  const computers = new Set(calls.filter(c => !/\/api\/(saved|board\/projects)/.test(c.url)).map(c => computerOf(c.url)));
  assert.equal(computers.size, 1, 'every request of the viewer goes to one computer:\n  ' + asked().join('\n  '));
 } finally { document.querySelector('.artifact-viewer-close')?.click(); state.selectedTeam = ''; }
});
test('control: the server named, everything goes to it', async () => {
 state.selectedTeam = '@ws1/dev'; calls = [];
 try {
  viewer.openArtifactViewer(hex, { board: 'dev', server: 'ws1', filename: 'report.md', editSaved: true });
  await new Promise(r => setTimeout(r, 600));
  const computers = new Set(calls.filter(c => !/\/api\/(saved|board\/projects)/.test(c.url)).map(c => computerOf(c.url)));
  assert.deepEqual([...computers], ['ws1'], asked().join(' | '));
 } finally { document.querySelector('.artifact-viewer-close')?.click(); state.selectedTeam = ''; }
});
