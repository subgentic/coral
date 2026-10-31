// The phone's navigation model (#11236, #11239): every view the dashboard can show declares a screen type in phone_screens.js, so no screen can be added without its header, back, tabs, primary action and bottom-nav rules.
// This reads VIEW_IDS in view_switch.js and checks the table against it: every view is declared, with a known type, a build slice, and (a top-level screen) a bottom-nav slot the nav has; nothing in the table is a view that is gone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHONE_SCREENS, SCREEN_TYPES, BUILT } from '../../coral-go/pkg/frontend/static/phone_screens.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../coral-go/pkg/frontend');
const sw = fs.readFileSync(path.join(root, 'static/view_switch.js'), 'utf8');
const ids = [...sw.slice(sw.indexOf('const VIEW_IDS'), sw.indexOf('];', sw.indexOf('const VIEW_IDS'))).matchAll(/"([a-z-]+)"/g)].map(m => m[1]);
const tpl = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8');
const slots = new Set([...tpl.matchAll(/data-phone-nav="([a-z-]+)"/g)].map(m => m[1])); // the bar's four tabs (#11535: Agents, Inbox, Automations, Analytics, in that order); a place of the ☰ menu (Docs, Computers, Chats) is a top-level screen with the bar on and no tab lit: its slot is 'menu'
slots.add('menu');
const bad = [];
const order = [...tpl.matchAll(/data-phone-nav="([a-z-]+)"/g)].map(m => m[1]).join();
if (order !== 'nav-agents,nav-inbox,nav-automations,nav-analytics') bad.push(`the bar's tabs are Agents, Inbox, Automations, Analytics in that order, not ${order}`);
if (ids.length < 10) bad.push(`could not read VIEW_IDS (${ids.length} found)`);
for (const id of ids) {
    const s = PHONE_SCREENS[id];
    if (!s) { bad.push(`${id}: not declared in phone_screens.js (say top-level, drill-down or form)`); continue; }
    if (!SCREEN_TYPES[s.type]) bad.push(`${id}: unknown type "${s.type}"`);
    if (!/^[A-D]$/.test(s.slice || '')) bad.push(`${id}: no build slice (A to D)`);
    const navs = typeof s.nav === 'function' ? ['hub-inbox', 'automations', 'tokens', 'docs', 'agents'].map(t => s.nav(t)) : [s.nav]; // a page that serves two tabs says its slot from the open tab
    if (s.type === 'top-level') for (const n of navs) if (n && !slots.has(n)) bad.push(`${id}: nav slot "${n}" is not one of the nav's (${[...slots].join(', ')})`);
    if (SCREEN_TYPES[s.type] && SCREEN_TYPES[s.type].bottomNav && BUILT.has(s.slice) && !s.nav) bad.push(`${id}: a built top-level screen says which nav slot is lit`);
}
for (const id of Object.keys(PHONE_SCREENS)) if (!ids.includes(id)) bad.push(`${id}: declared in phone_screens.js but not a view in view_switch.js`);
if (!BUILT.has('A')) bad.push('slice A is not marked built');
if (bad.length) { console.error('phone_screens_census FAIL:\n  ' + bad.join('\n  ')); process.exit(1); }
console.log(`phone_screens_census: ok (${ids.length} views declared)`);
