// The cards that start something say the same on every screen (#9998, the phone triage): the phone's empty Agents page (render.js draws it from launch_cards.js), the desktop's welcome page
// and the New dialog's chooser carry the same icons, labels, descriptions and order; the dialog adds Terminal after them. A word changed in one place and not the others fails here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'coral-go', 'pkg', 'frontend');
const read = p => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const { LAUNCH_CARDS } = await import(path.join(root, 'static', 'launch_cards.js'));
const want = LAUNCH_CARDS.map(c => [c.icon, c.label, c.desc]);

const welcome = [...read('templates/index.html').matchAll(/<button class="welcome-launch"[\s\S]*?welcome-launch-icon material-icons" aria-hidden="true">([^<]*)<\/span>\s*<span class="welcome-launch-copy"><strong>([^<]*)<\/strong><span>([^<]*)<\/span>/g)].map(m => [m[1], m[2], m[3]]);
assert.deepEqual(welcome, want, 'the desktop welcome page');

const chooser = [...read('templates/includes/modals.html').matchAll(/<button class="launch-type-card"[\s\S]*?launch-type-glyph" aria-hidden="true">([^<]*)<\/span>[\s\S]*?launch-type-label">([^<]*)<\/div>\s*<div class="launch-type-desc">([^<]*)<\/div>/g)].map(m => [m[1], m[2], m[3]]);
assert.deepEqual(chooser, [...want, ['terminal', 'Terminal', 'Open a shell next to your agents.']], "the New dialog's chooser: the same cards in the same order, then Terminal");

assert.ok(/LAUNCH_CARDS\.map\(phoneCard\)/.test(read('static/render.js')), "the phone's empty page is drawn from the table");
console.log('launch_cards_census: ok (3 cards on 3 screens, Terminal only in the dialog)');
