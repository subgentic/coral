// A normal end of turn is not a red "Agent stopped: unknown" row (#16395): the stop icon is red only for a real stop.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local' });
const { getToolIcon, isNormalTurnEnd } = await importUi('event_icons');
const { eventRowHtml } = await importUi('event_row');
for (const summary of ['Agent stopped: unknown', 'Agent stopped: end_turn', 'Agent stopped: STOP', 'Turn ended'])
    assert.equal(getToolIcon('', 'stop', summary).cls, 'tool-turn-end', summary);
for (const summary of ['Agent stopped: error', 'Agent stopped: interrupted', 'Agent stopped: usage_limit'])
    assert.equal(getToolIcon('', 'stop', summary).cls, 'tool-stop', summary + ' stays red');
assert.equal(getToolIcon('', 'stop').cls, 'tool-stop', 'no summary: as before');
assert.equal(isNormalTurnEnd({ event_type: 'notification', summary: 'Turn ended' }), false);
const row = eventRowHtml({ event_type: 'stop', summary: 'Agent stopped: unknown', created_at: '2026-11-14T08:00:00Z' });
assert.ok(row.includes('tool-turn-end') && !/tool-stop\b/.test(row), 'the row is not red');
console.log('turn_end_quiet: ok');
