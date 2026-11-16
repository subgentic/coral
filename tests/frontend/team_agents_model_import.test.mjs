// #18160 (Security SHOULD on #16671): the Agents page is a lazy module; the Model column's words (model_labels.js, which the start bundle already loads) come by a plain static import, not by one more
// top-level await in the page. A static import of a module the start bundle holds costs nothing and cannot fail late.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../../coral-go/pkg/frontend/static/team_agents_page.js', import.meta.url), 'utf8');
assert.ok(!/await importOnce\('\.\/model_labels\.js'\)/.test(src), 'team_agents_page.js must not await model_labels.js at the top level');
assert.ok(/^import \{[^}]*\bmodelName\b[^}]*\} from '\.\/model_labels\.js';/m.test(src), 'team_agents_page.js imports modelName from model_labels.js statically');
const start = fs.readFileSync(new URL('../../coral-go/pkg/frontend/static/render.js', import.meta.url), 'utf8');
assert.ok(/^import (?:[^;]* from )?'\.\/model_labels\.js';/m.test(start), 'model_labels.js is already in the start bundle (render.js imports it), so the static import adds nothing');
console.log('team_agents_model_import: ok');
