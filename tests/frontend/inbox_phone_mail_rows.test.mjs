// The phone Inbox's last folders (#9583, Goal #100, UI/UX's spec #9529): the drawer has a Boards group (each team's board by name, nothing else asked of the server than the project list the Board tab reads),
// and Goals, Saved and Artifacts are mail rows on a phone (a glyph, the title, the first words, the time). A desktop keeps its tables and its folders without Boards. Local mode, a phone window by a stubbed
// matchMedia; the real Inbox is drawn.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'coral-go', 'pkg', 'frontend');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const dom = installDom({ mode: 'local' });
let phone = true;
window.matchMedia = globalThis.matchMedia = q => ({ matches: phone && /max-width: 767px/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
const calls = [];
globalThis.fetch = window.fetch = async url => {
    const p = new URL(url, 'https://coral.example').pathname; calls.push(p);
    if (p === '/api/board/projects') return Response.json([{ project: 'beta-team', board_label: 'Beta team' }, { project: 'alpha-team', board_label: 'Alpha team' }]);
    if (p === '/api/goals') return Response.json({ goals: [{ id: 7, board_id: 'alpha-team', title: 'Ship the Hub', outcome: 'The Hub is live', state: 'active', updated_at: new Date(Date.now() - 3600e3).toISOString(), rollup: { total: 2, done: 1 } }] });
    return Response.json({});
};
const settle = ms => new Promise(r => setTimeout(r, ms));
const folderButtons = () => [...document.querySelectorAll('#inbox-nav-list button')];
const words = () => folderButtons().map(b => b.textContent.replace(/^[a-z_]+(?=[A-Z])/, '').trim());
try {
    const { state } = await importUi('state'); state.hub = false;
    document.body.setAttribute('data-nav-tab', 'hub-inbox');
    (await importUi('inbox_tab')).showInboxTabContent();
    await settle(1500);
    let w = words();
    assert.ok(w.some(x => /^Alpha team/.test(x)) && w.some(x => /^Beta team/.test(x)), `the drawer's Boards group names each team: ${w}`);
    assert.ok(w.indexOf(w.find(x => /^Alpha team/.test(x))) < w.indexOf(w.find(x => /^Beta team/.test(x))), 'by name');
    assert.ok(calls.includes('/api/board/projects'), 'the Boards group reads the project list the Board tab reads');
    // Goals: a mail row
    folderButtons().find(b => /Goals/.test(b.textContent)).click(); await settle(500);
    const row = document.querySelector('#group-table-view .dt-mailed');
    assert.ok(row, 'Goals is mail rows on a phone');
    assert.equal(row.querySelector('.dt-mail-title').textContent, 'Ship the Hub');
    assert.equal(row.querySelector('.dt-mail-snippet').textContent, 'The Hub is live');
    assert.ok(row.querySelector('.dt-mail-time').textContent.length > 0, 'with its time');
    assert.equal(row.querySelector('.dt-mail-avatar').textContent, 'flag');
    // the other two folders carry their rows' spec
    const sidebar = read('static/inbox_sidebar.js'), arts = read('static/team_artifacts_page.js');
    assert.match(sidebar, /mail: f => \(\{ lead: \{ text: f\.title \|\| f\.which, name: f\.title \|\| f\.which \}, title: f\.title \|\| f\.which, snippet: f\.snip, time: f\.saved \}\)/, 'Saved: who it is from, the message as its name cuts it, when it was saved');
    assert.match(sidebar, /\.\.\.\(dock \? \{\} : \{ mail: f =>/, "the agent dock's Saved tab keeps its table: only the Inbox page has the mail row");
    assert.match(arts, /\.\.\.\(inbox \? \{ mail: item => \(\{ lead: \{ icon: 'description'/, 'Artifacts of the Inbox: a file glyph, the name, its team and task');
    assert.ok(!/mail:/.test(arts.slice(0, arts.indexOf('...(inbox ? { mail:'))), 'only the Inbox list, not the team page, agent or goal lists');
    // a board of the group opens that board's messages in the Inbox (its address), not the Board history folder
    folderButtons().find(b => /^[a-z_]*Alpha team/.test(b.textContent.trim())).click(); await settle(500);
    assert.equal(location.pathname, '/inbox/boards/alpha-team', 'the board opens in the Inbox at its address');
    console.log('inbox_phone_mail_rows: ok');
} catch (e) { console.error(e); process.exitCode = 1; } finally { dom.window.close(); setTimeout(() => process.exit(process.exitCode || 0), 50).unref?.(); }
