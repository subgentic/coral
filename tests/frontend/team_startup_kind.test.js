const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../../coral-go/pkg/frontend/static/team_startup_waits.js'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^await loadStyles.*;\n/gm, '').replace(/export /g, '');
const dom = new JSDOM('<div id="host"></div>');
const state = {liveSessions: []};
const draw = new Function('state', 'inTeam', 'sessionServer', 'resolveSessionIdentity', 'askWords', 'document', 'window', source + '\nreturn drawStartupWaits;')(
    state, s => s.board_project === 'team', () => '', s => s.name, s => s, dom.window.document, dom.window);
const host = dom.window.document.getElementById('host');
const row = {session_id:'one',name:'Lead Developer',board_project:'team',waiting_for_input:true,waiting_kind:'question',waiting_summary:'Which browser should I use?'};
state.liveSessions = [row]; draw(host, 'team');
assert.equal(host.hidden, true, 'an ordinary question mentioning browser is not a startup wait');
row.waiting_kind = 'startup'; draw(host, 'team');
assert.equal(host.hidden, false, 'authoritative startup kind appears');
assert.match(host.textContent, /Lead Developer: Which browser should I use/);
row.waiting_for_input = false; draw(host, 'team');
assert.equal(host.hidden, true, 'answer clears the startup warning');
console.log('team_startup_kind: ok');
