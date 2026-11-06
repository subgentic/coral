/* The owner's rendered-Markdown edit contract. Paths always retain the document's
 * computer/team; capability is server-granted, never inferred from a file name. */
import { boardTeamKey, splitKey, normServer, boardFetch, serverUrl, artifactPath, isCloud, isHub, isLocalServer } from './server_base.js';
export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
export const HUB_MARKDOWN_BYTES = 64 * 1024;
const preflight = text => Object.assign(new Error(text), { preflight: true });
const HEX = /^[a-f0-9]{64}$/;
const pathFor = hex => { if (!HEX.test(String(hex))) throw new Error('This document cannot be edited.'); return `/artifacts/${hex}/edit`; };
export function editContext(server, board, hex) {
    if (!board || !HEX.test(String(hex))) return null;
    const key = boardTeamKey(server, board), team = splitKey(key);
    if (!team.name || team.name.startsWith('@') || team.server !== normServer(server)) return null;
    return { key, server: team.server, board: team.name, hex };
}
async function dataOf(response) {
    let data = {}; try { data = await response.json(); } catch { /* no body */ }
    if (!response.ok) { const error = new Error(typeof data.error === 'string' ? data.error : `The document could not be saved (HTTP ${response.status}).`); error.status = response.status; error.data = data; throw error; }
    return data;
}
export async function editCapability(context, { signal } = {}) {
    if (!context) return null;
    const response = await boardFetch(context.key, pathFor(context.hex), { signal, headers: { Accept: 'application/json' } });
    if ([403, 404, 405].includes(response.status)) return null;
    const data = await dataOf(response);
    if (data?.can_edit !== true) return null;
    return data;
}
export async function readEditSource(context, { signal } = {}) {
    const response = await fetch(serverUrl(artifactPath(context.hex), context.server), { signal });
    if (!response.ok) throw new Error(`The document could not be read (HTTP ${response.status}).`);
    const known = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(known) && known > MAX_MARKDOWN_BYTES) { await response.body?.cancel(); throw new Error('Markdown editing is limited to 2 MiB.'); }
    const reader = response.body?.getReader(); const chunks = []; let size = 0;
    if (reader) {
        try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_MARKDOWN_BYTES) throw new Error('Markdown editing is limited to 2 MiB.'); chunks.push(value); } }
        catch (error) { await reader.cancel().catch(() => {}); throw error; }
    } else { const bytes = new Uint8Array(await response.arrayBuffer()); size = bytes.length; chunks.push(bytes); }
    if (size > MAX_MARKDOWN_BYTES) throw new Error('Markdown editing is limited to 2 MiB.');
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    // ignoreBOM=true exposes U+FEFF to the model instead of silently consuming its bytes.
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error('This file is not valid UTF-8 Markdown.'); }
}
export async function saveMarkdown(context, source, expectedLatest, { signal } = {}) {
    if (!HEX.test(String(expectedLatest))) throw preflight('Reload the document before saving.');
    const body = new TextEncoder().encode(source);
    if (body.byteLength > MAX_MARKDOWN_BYTES) throw preflight('Markdown editing is limited to 2 MiB.');
    if ((isCloud() || isHub()) && !isLocalServer(context.server) && body.byteLength > HUB_MARKDOWN_BYTES) throw preflight('This document is larger than the Hub’s 64 KiB save limit. Save it on the computer’s own dashboard.');
    return dataOf(await boardFetch(context.key, `${pathFor(context.hex)}?expected_latest=${expectedLatest}`, { method: 'POST', headers: { 'Content-Type': 'text/markdown; charset=utf-8' }, body, signal }));
}
