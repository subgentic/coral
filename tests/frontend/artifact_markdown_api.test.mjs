import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local' });
const { state } = await importUi('state');
const A = await importUi('artifact_markdown_api');
const hex = 'a'.repeat(64), next = 'b'.repeat(64), context = A.editContext('m1', 'dev', hex);
let calls = [], response;
globalThis.fetch = window.fetch = async (url, options = {}) => { calls.push({ url: String(url), ...options }); return response || Response.json({ can_edit: true }); };
test('capability uses the viewed computer/team, requires literal permission, and does not infer it from an artifact', async () => {
    assert.deepEqual(context, { key: '@m1/dev', server: 'm1', board: 'dev', hex });
    calls = []; response = Response.json({ can_edit: 'true' }); assert.equal(await A.editCapability(context), null);
    assert.equal(calls[0].url, `/api/remote/m1/api/board/dev/artifacts/${hex}/edit`);
    for (const status of [403, 404, 405]) { response = new Response('', { status }); assert.equal(await A.editCapability(context), null); }
    assert.equal(A.editContext('m1', '', hex), null);
    assert.equal(A.editContext('m1', '@m2/dev', hex), null, 'a foreign team key cannot redirect the viewed document to another computer');
});
test('edit read preserves exact UTF-8 BOM/CRLF bytes and rejects invalid UTF-8 and oversized content', async () => {
    const text = '\ufeff# A title\r\n\r\nA 🍊 sentence.\r\n'; response = new Response(new TextEncoder().encode(text)); calls = [];
    assert.equal(await A.readEditSource(context), text);
    assert.match(calls[0].url, /^\/api\/remote\/m1\/api\/artifacts\//);
    response = new Response(Uint8Array.from([0xc0, 0xaf])); await assert.rejects(A.readEditSource(context), /valid UTF-8/);
    response = new Response('x', { headers: { 'Content-Length': String(A.MAX_MARKDOWN_BYTES + 1) } }); await assert.rejects(A.readEditSource(context), /2 MiB/);
});
test('save sends exact bytes with a stamp-bound expected-latest query, preserving source content', async () => {
    const text = '\ufeff# Title\r\n\r\nOne revised sentence.\r\n'; calls = []; response = Response.json({ digest: next, version: 2 }); state.hub = true;
    assert.equal((await A.saveMarkdown(context, text, hex)).digest, next);
    assert.equal(calls[0].url, `/api/remote/m1/api/board/dev/artifacts/${hex}/edit?expected_latest=${hex}`);
    assert.equal(calls[0].method, 'POST'); assert.deepEqual(Buffer.from(calls[0].body), Buffer.from(text));
    assert.match(calls[0].headers['Content-Type'], /^text\/markdown/);
});
test('Hub transport cap refuses whole before a request; local content cap remains 2 MiB', async () => {
    state.hub = true; calls = []; await assert.rejects(A.saveMarkdown(context, 'x'.repeat(A.HUB_MARKDOWN_BYTES + 1), hex), /computer’s own dashboard/); assert.equal(calls.length, 0);
    await assert.rejects(A.saveMarkdown(A.editContext('local', 'dev', hex), 'x'.repeat(A.MAX_MARKDOWN_BYTES + 1), hex), /2 MiB/); assert.equal(calls.length, 0);
});
test('server 409 retains conflict metadata and never automatically retries', async () => {
    calls = []; response = Response.json({ error: 'A newer version exists.', latest_digest: next, latest_version: 2 }, { status: 409 });
    await assert.rejects(A.saveMarkdown(context, 'new words', hex), error => error.status === 409 && error.data.latest_digest === next);
    assert.equal(calls.length, 1);
});
