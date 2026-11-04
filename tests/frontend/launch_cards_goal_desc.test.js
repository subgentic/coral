// The goal card's line is updated when the teams read lands (setNoTeam), and that can be while someone types: it must look only into the places the card is drawn (the welcome page, the sidebar's list, the phone's Agents page), never over the whole document (perf_budgets_browser:
// "typing makes no page-wide lookup per keystroke (1: [data-goal-desc])", v2.0.44's cdp gate). Pure node with a stand-in document:  node launch_cards_goal_desc.test.js
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
    const dir = path.resolve(__dirname, '../../coral-go/pkg/frontend/static');
    const mk = () => ({ textContent: 'plain' });
    const welcomeEl = mk(), phoneEl = mk(), listEl = mk(), strayEl = mk();
    const root = els => ({ querySelectorAll: sel => (sel === '[data-goal-desc]' ? els : []) });
    const docCalls = [];
    globalThis.document = {
        addEventListener() {},
        getElementById: id => (id === 'welcome-screen' ? root([welcomeEl]) : id === 'live-sessions-list' ? root([listEl]) : id === 'mobile-agent-list' ? root([phoneEl]) : null),
        querySelectorAll: sel => { docCalls.push(sel); return [welcomeEl, phoneEl, strayEl]; }, // a page-wide lookup: recorded, and it would also reach an element outside both places
    };
    const m = await import(pathToFileURL(path.join(dir, 'launch_cards.js')).href);
    m.setNoTeam(true);
    assert.deepEqual(docCalls, [], 'no selector over the whole document: ' + JSON.stringify(docCalls));
    assert.equal(welcomeEl.textContent, m.GOAL_NO_TEAM_DESC, 'the welcome page says there is no team');
    assert.equal(listEl.textContent, m.GOAL_NO_TEAM_DESC, "and so does the sidebar's empty Agents list");
    assert.equal(phoneEl.textContent, m.GOAL_NO_TEAM_DESC, "and the phone's Agents page");
    assert.equal(strayEl.textContent, 'plain', 'nothing outside the two places is touched');
    m.setNoTeam(false);
    assert.equal(welcomeEl.textContent, m.goalDesc());
    assert.notEqual(welcomeEl.textContent, m.GOAL_NO_TEAM_DESC, 'a team exists again: the plain line');
    console.log('launch_cards_goal_desc: ok');
})().catch(e => { console.error(e); process.exit(1); });
