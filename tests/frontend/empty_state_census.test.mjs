// The one empty state (#9097, Goal #84 spec item 8): a line, an optional hint, an optional action, no box. This census fails on an empty-state class outside the family, in the stylesheets and in the
// scripts and templates: the 16 base classes and their 65 hand-built uses were one look each (14 looks in 16 classes, the audit). A new class whose name says "empty" goes in the family
// (.empty-state, -line, -hint, -action, -tight) or, if it is not an empty state at all (a hero, a card, a screen-reader node), in the list below with the reason.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'coral-go', 'pkg', 'frontend');
const walk = (dir, ext, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== 'vendor') walk(p, ext, out); } else if (ext.some(x => p.endsWith(x))) out.push(p); } return out; };

const FAMILY = new Set(['empty-state', 'empty-state-line', 'empty-state-hint', 'empty-state-action', 'empty-state-tight']);
const NOT_AN_EMPTY_STATE = new Map([
    ['chat-empty', 'the first-run hero of a chat with no transcript; the chat logic keeps it out of the transcript (chat_content.js)'],
    ['chat-empty-title', 'its title'], ['chat-empty-hint', 'its hint'],
    ['composer-waiting-empty', 'a screen-reader-only node'],
    ['empty-launch', 'the welcome page launch cards (cards, not an empty line)'], ['empty-launch-arrow', 'the same card'], ['empty-launch-copy', 'the same card'], ['empty-launch-icon', 'the same card'], ['empty-launch-list', 'the same cards'],
    ['empty-welcome', 'the phone Home (a title, a sentence and the launch cards)'], ['empty-plain', 'the desktop list line that the phone Home replaces'],
    ['hub-connect-empty', 'the connect-a-computer card of Coral Hub: a button and a sentence inside the agent list'],
    ['empty-notes', 'a notes panel state name, not an empty-state box'], ['empty-send-nudge', 'a composer nudge, not an empty-state box'],
]);
const OLD = ['ac-empty', 'board-chat-empty', 'board-task-empty', 'cost-empty', 'dep-picker-empty', 'dt-empty', 'dt-empty-line', 'dt-empty-hint', 'event-empty', 'file-empty', 'goals-empty', 'ibx-empty', 'ibx-thread-none',
    'model-chip-empty', 'servers-empty', 'task-empty', 'team-agents-empty', 'team-empty', 'team-empty-line', 'team-empty-hint', 'template-browser-empty', 'empty-pane', 'empty-line', 'empty-hint'];

const cssText = walk(path.join(root, 'static', 'css'), ['.css']).map(f => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
const sourceText = [...walk(path.join(root, 'static'), ['.js']), ...walk(path.join(root, 'templates'), ['.html'])].map(f => fs.readFileSync(f, 'utf8')).join('\n');

const problems = [];
const classes = new Set([...cssText.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map(m => m[1]));
for (const c of classes) if (/(^|-)empty($|-)/.test(c) && !FAMILY.has(c) && !NOT_AN_EMPTY_STATE.has(c)) problems.push(`css: .${c} is an empty-state class outside the family (use .empty-state, or add it to NOT_AN_EMPTY_STATE with the reason)`);
for (const o of OLD) {
    if (new RegExp(`\\.${o}(?![A-Za-z0-9_-])`).test(cssText)) problems.push(`css: .${o} is gone (the one empty state replaced it)`);
    if (new RegExp(`(?<![A-Za-z0-9_-])${o}(?![A-Za-z0-9_-])`).test(sourceText)) problems.push(`source: "${o}" is gone (the one empty state replaced it)`);
}
for (const c of FAMILY) if (!classes.has(c)) problems.push(`css: the family class .${c} has no rule`);
for (const c of NOT_AN_EMPTY_STATE.keys()) if (!classes.has(c) && !sourceText.includes(c)) problems.push(`list: ${c} is not used any more: take it off NOT_AN_EMPTY_STATE`);
if (problems.length) { console.error('empty_state_census: FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
console.log(`empty_state_census: ok (${FAMILY.size} family classes, ${NOT_AN_EMPTY_STATE.size} listed non-empty-states, ${OLD.length} old classes gone)`);
