// The age of a goal (#10123): the goal line is refreshed at most every 30 minutes, so a goal can be stale; the hover card and the open agent's header say how old it is ("Goal, 25 min ago"), from the row's summary_at.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

const { document } = installDom({ mode: 'local' });
const S = await importUi('session_state');
const now = Date.parse('2026-10-28T12:00:00Z');
const ago = min => new Date(now - min * 60000).toISOString();
assert.equal(S.goalAgeWords(ago(0), now), 'just now');
assert.equal(S.goalAgeWords(ago(25), now), '25 min ago');
assert.equal(S.goalAgeWords(ago(59), now), '59 min ago');
assert.equal(S.goalAgeWords(ago(60), now), '1 h ago');
assert.equal(S.goalAgeWords(ago(5 * 60 + 40), now), '5 h ago');
assert.equal(S.goalAgeWords(ago(24 * 60), now), '1 day ago');
assert.equal(S.goalAgeWords(ago(3 * 24 * 60), now), '3 days ago');
assert.equal(S.goalAgeWords(ago(-5), now), 'just now', 'a clock a little ahead is not a negative age');
assert.equal(S.goalAgeWords('', now), ''); assert.equal(S.goalAgeWords(null, now), ''); assert.equal(S.goalAgeWords('not a time', now), '');

// the hover card names the age in its Goal label, and says plain Goal when the row has no time
const row = (o = {}) => ({ name: 'worker', agent_type: 'claude', session_id: 's1', summary: 'Build the thing', staleness_seconds: 30, ...o });
const text = html => String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
assert.match(text(S.buildSessionTooltip(row({ summary_at: new Date(Date.now() - 25 * 60000).toISOString() }))), /Goal, 25 min ago Build the thing/);
assert.match(text(S.buildSessionTooltip(row())), /Goal Build the thing/);
assert.doesNotMatch(text(S.buildSessionTooltip(row())), /Goal,/);
console.log('goal_age: ok');
