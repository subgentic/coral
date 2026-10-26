// template_browser_data.js: what the aitmpl.com answers hold, the filters, the names a row shows and the preview's words (#8413).
import assert from 'node:assert/strict';
import { categoriesOf, templatesOf, categoryName, filterCategories, filterTemplates, templateName, displayName, previewParts } from '../../coral-go/pkg/frontend/static/template_browser_data.js';

assert.deepEqual(categoriesOf({ categories: ['a'] }), ['a']);
assert.deepEqual(categoriesOf({ commands: ['b'] }), ['b']);
assert.deepEqual(categoriesOf(['c']), ['c'], 'a bare list is the list');
assert.deepEqual(categoriesOf({ categories: ['a'], commands: ['b'] }), ['a'], 'categories come first');
assert.deepEqual(templatesOf({ agents: [1] }), [1]);
assert.deepEqual(templatesOf({ commands: [2] }), [2]);
assert.deepEqual(templatesOf([3]), [3]);
assert.deepEqual(templatesOf({ agents: [1], commands: [2] }), [1], 'agents come first');

assert.equal(categoryName({ name: 'dev-tools' }), 'dev-tools');
assert.equal(categoryName('plain'), 'plain');
const cats = [{ name: 'Dev-Tools' }, 'security', { name: 'data-science' }];
assert.deepEqual(filterCategories(cats, ''), cats);
assert.deepEqual(filterCategories(cats, undefined), cats);
assert.deepEqual(filterCategories(cats, 'TOOL'), [{ name: 'Dev-Tools' }], 'any case, anywhere in the name');
assert.deepEqual(filterCategories(cats, 'sec'), ['security']);
assert.deepEqual(filterCategories(cats, 'zzz'), []);

const tpls = [{ name: 'code-reviewer' }, { filename: 'Test-Writer.md' }, { name: 'api-docs', filename: 'x.md' }, {}];
assert.equal(filterTemplates(tpls, '').length, 4);
assert.deepEqual(filterTemplates(tpls, 'REVIEW'), [{ name: 'code-reviewer' }]);
assert.deepEqual(filterTemplates(tpls, 'writer'), [{ filename: 'Test-Writer.md' }], 'a file name is searched when there is no name');
assert.deepEqual(filterTemplates(tpls, '.md'), [{ filename: 'Test-Writer.md' }], 'the file name is searched with its .md');
assert.deepEqual(filterTemplates(tpls, 'x.md'), [], 'a name hides the file name');

assert.equal(templateName({ name: 'a-b' }), 'a-b');
assert.equal(templateName({ filename: 'a-b.md' }), 'a-b', 'a file name loses its .md');
assert.equal(templateName({ filename: 'a.mdx' }), 'a.mdx', 'only a trailing .md');
assert.equal(templateName({}), '');
assert.equal(displayName('a-b-c'), 'a b c');

const p = previewParts({ name: 'code-reviewer', description: 'Reviews', body: 'x'.repeat(600), model: 'opus', tools: 'Read, Grep', allowed_tools: 'Bash', argument_hint: '<file>' }, 'fallback', 'agents');
assert.equal(p.displayName, 'code reviewer');
assert.equal(p.desc, 'Reviews');
assert.equal(p.body, 'x'.repeat(500) + '...', 'a long body is cut at 500 characters');
assert.deepEqual(p.meta, ['Model: opus', 'Tools: Read, Grep', 'Tools: Bash', 'Args: <file>']);
assert.equal(p.btnLabel, 'Use Template');
const q = previewParts({ body: 'y'.repeat(500) }, 'my-cmd', 'commands');
assert.equal(q.displayName, 'my cmd', 'the name asked for when the template has none');
assert.equal(q.body.length, 500, 'a body of exactly 500 is not cut');
assert.deepEqual(q.meta, []);
assert.equal(q.desc, '');
assert.equal(q.btnLabel, 'Add as Macro');
assert.equal(previewParts({}, 'n', 'agents').body, '');
