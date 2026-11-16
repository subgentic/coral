// The health settings do not contradict each other (#17345, walk 65 F3): the backend never posts the all-clear while the minutes are 0, so both lines say so.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const src = fs.readFileSync(new URL('../../coral-go/pkg/frontend/static/team_health_fields.js', import.meta.url), 'utf8');
const line = key => (src.split('\n').find(l => l.includes(`key: '${key}'`)) || '');
assert.match(line('heartbeat_min'), /no all-well post, even with Post when all is well on/, 'the minutes field says 0 means nothing is posted, whatever the switch');
assert.match(line('all_clear'), /never with 0/, 'the switch says it needs minutes');
console.log('PASS team_health_all_clear_line: the switch and the minutes field say the same thing about 0');
