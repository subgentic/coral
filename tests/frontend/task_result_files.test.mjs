// A path in a task's result that names a file in its worker's folder is a link (#18200, walk 31 F13): only a path under the agent's folder, nothing that climbs out of it, nothing that is not a file name.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const { relPath, split } = await import(pathToFileURL(path.resolve(here, '../../coral-go/pkg/frontend/static/task_result_paths.js')).href);
const W = '/Users/me/csvstats';

assert.equal(relPath('README.md', W), 'README.md');
assert.equal(relPath('src/app.js', W), 'src/app.js');
assert.equal(relPath('./src/app.js', W), 'src/app.js');
assert.equal(relPath(W + '/docs/a.md', W), 'docs/a.md', 'an absolute path inside the folder is its relative path');
assert.equal(relPath('/etc/passwd.txt', W), '', 'an absolute path outside the folder is no link');
assert.equal(relPath(W + 'x/a.md', W), '', 'a sibling folder with the same prefix is outside');
assert.equal(relPath('../secret.md', W), '', 'nothing climbs out');
assert.equal(relPath('a/../../b.md', W), '');
assert.equal(relPath('-rf.md', W), '', 'nothing starts with a dash');
assert.equal(relPath('/x/a.md', ''), '', 'no folder: no absolute path');

const links = (t) => split(t, W).filter(p => p.rel).map(p => p.rel);
assert.deepEqual(links('Wrote README.md and src/app.js (see docs/guide.md), done.'), ['README.md', 'src/app.js', 'docs/guide.md']);
assert.deepEqual(links(`Open ${W}/index.html.`), ['index.html']);
assert.deepEqual(links('v2.0.69 e.g. the 3.5 build, www.example.com'), [], 'a version, an abbreviation or a web address is no file');
assert.deepEqual(links('see /etc/hosts.txt and ../up.md'), [], 'outside the folder: no link');
assert.deepEqual(links('the .env file and secrets.env'), [], 'a file with no listed extension is no link');
assert.equal(split('Wrote README.md here', W).map(p => p.text).join(''), 'Wrote README.md here', 'the words are kept whole around a link');
console.log('task_result_files.test.mjs: ok');
