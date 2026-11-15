// #17974 (Security's note on #17485): a stylesheet that cannot be fetched must not hold a page back. loadStyles resolves when the sheet fails (so team_knowledge_page's load(), which awaits it before it fetches the
// team's knowledge, goes on), forgets the failure so the next call asks again, and never throws.
import assert from 'node:assert/strict';

const links = [];
globalThis.document = { head: { appendChild: (l) => { links.push(l); } }, createElement: () => ({ remove() { this.removed = true; } }) };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mozilla/5.0 (X11; Linux) Chrome/130' }, configurable: true }); // not jsdom: the real path
const { loadStyles } = await import('../../coral-go/pkg/frontend/static/lazy_styles.js');

// a sheet that fails: the promise resolves, the link is removed
const first = loadStyles('knowledge_note.css');
assert.equal(links.length, 1, 'one link was added');
links[0].onerror();
await assert.doesNotReject(first, 'a failed sheet still resolves');
assert.equal(links[0].removed, true, 'the dead link is removed');

// the failure is forgotten: the next call asks again with a new link, and a sheet that loads resolves it
const second = loadStyles('knowledge_note.css');
assert.equal(links.length, 2, 'the next call asks again');
links[1].onload();
await second;

// a loaded sheet is not asked for twice
await loadStyles('knowledge_note.css');
assert.equal(links.length, 2, 'a sheet that loaded is kept');

// the page's own order: await the sheet, then fetch, even when the sheet failed
let fetched = false;
const page = (async () => { const p = loadStyles('other.css'); links[2].onerror(); await p; fetched = true; })();
await page;
assert.equal(fetched, true, 'load() goes on to fetch after a failed sheet');
console.log('lazy_styles_failure: ok');
