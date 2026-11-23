// #20817: through a Hub the chat sends the folder-relative path (the tunnel refuses a value starting with / or ~).
// Security's terms: strip only the session's own folder at a whole-segment boundary, never a git root, never produce '..' or a leading / or ~, and the outside answer comes from the path alone.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
    const { hubFileRef: h, outsideWords } = await import(pathToFileURL(path.resolve(__dirname, '../../coral-go/pkg/frontend/static/hub_file_ref.js')).href);
    const F = '/work/app';
    // 1. inside the folder: relative
    assert.deepEqual(h('/work/app/src/a.js', F), { ref: 'src/a.js' });
    assert.deepEqual(h('/work/app/src/a.js:12', F), { ref: 'src/a.js', line: 12 }, 'the line suffix is taken off and kept as the line');
    assert.deepEqual(h('/work/app/src/a.js:12:5', F), { ref: 'src/a.js', line: 12 }, 'line and column');
    assert.deepEqual(h('src/a.js:12', F), { ref: 'src/a.js', line: 12 }, 'a relative reference too');
    assert.deepEqual(h('/etc/a.js:3', F), { outside: true }, 'outside stays outside');
    assert.deepEqual(h('/work/app/a.js:12:', F), { ref: 'a.js:12:' }, 'a dangling colon is not a suffix: sent as is');
    assert.deepEqual(h('C:\\Work\\App\\a.js:7', 'C:\\Work\\App'), { ref: 'a.js', line: 7 }, 'a drive path with a line');
    assert.ok(!h('/work/app/a.js:12:5', F).ref.includes(':'), 'no colon is sent');
    assert.deepEqual(h('/work/app/a.js', F + '/'), { ref: 'a.js' }, 'a trailing slash on the folder');
    assert.deepEqual(h('/work//app/./src/a.js', F), { ref: 'src/a.js' }, 'doubled and dot segments');
    assert.deepEqual(h('file:///work/app/a.js', F), { ref: 'a.js' });
    // 2. whole segments, not string prefixes
    assert.deepEqual(h('/work/app2/a.js', F), { outside: true }, '/work/app2 is not inside /work/app');
    assert.deepEqual(h('/work/rel/a.js', '/work/release'), { outside: true });
    assert.deepEqual(h('/work/app', F), { outside: true }, 'the folder itself is not a file');
    // 3. never a git root: the parent of the folder is outside
    assert.deepEqual(h('/work/README.md', F), { outside: true });
    // 4. never '..', '/' or '~'
    assert.deepEqual(h('/work/app/../secret', F), { outside: true });
    assert.deepEqual(h('/work/app/a/../../b', F), { outside: true });
    for (const r of ['/work/app/src/a.js', '/work/app/x/..', '~/a.js', '/etc/passwd']) { const o = h(r, F); if (o.ref !== undefined) assert.ok(!/^[/~]/.test(o.ref) && !o.ref.split('/').includes('..'), r); }
    assert.deepEqual(h('~/a.js', F), { outside: true });
    assert.deepEqual(h('/etc/passwd', F), { outside: true });
    assert.deepEqual(h('/work/app/a.js', ''), { outside: true }, 'no known folder: no guess');
    // 5. not absolute: unchanged, the tunnel decides as today
    assert.deepEqual(h('src/a.js', F), { ref: 'src/a.js' });
    assert.deepEqual(h('../a.js', F), { ref: '../a.js' });
    // 6. Windows: drive letters, backslashes, case
    assert.deepEqual(h('C:\\Work\\App\\src\\a.js', 'c:/work/app'), { ref: 'src/a.js' });
    assert.deepEqual(h('D:\\Work\\App\\a.js', 'C:\\Work\\App'), { outside: true }, 'another drive');
    assert.deepEqual(h('C:\\Work\\App2\\a.js', 'C:\\Work\\App'), { outside: true });
    assert.deepEqual(h('/work/app/a.js', 'C:\\Work\\App'), { outside: true }, 'a POSIX path against a drive folder');
    // 7. POSIX is case-sensitive
    assert.deepEqual(h('/work/App/a.js', F), { outside: true });
    assert.equal(outsideWords('Lead Dev'), "This file is outside Lead Dev's folder; it opens on that computer only.");
    console.log('PASS hub_file_ref');
})().catch(e => { console.error(e); process.exit(1); });
