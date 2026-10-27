// Which answers of a permission card a phone sets apart from the bar (#9583, QA Reviewer 2's matrix): every STANDING answer (a permanent or session-wide allow) is apart, every ONE-TIME answer stays in the
// bar, and an answer nobody recognised is apart (fail closed). The labels are the CLIs' own and the ones the review found.
import assert from 'node:assert/strict';
import { isOneTime, standingOptions } from '../../coral-go/pkg/frontend/static/standing_option.js';

const STANDING = [
    "Yes, and don't ask again for go test commands", "Yes, allow all edits during this session (shift+tab)", 'Allow for this session', 'Allow for all future sessions',
    'Yes, allow always', 'Allow always', 'Yes, always allow access to this folder', 'Always allow', "Yes, and never ask again", "Yes, don't ask me again", 'Yes, and remember this decision',
    'Yes, allow this for the rest of the session', 'Trust this folder', 'Yes, add to allowlist', "Yes, and don't ask again for this command (p)", 'Yes, and stop asking',
    "Don't ask again", 'Never ask again', 'Approve and remember', 'Something nobody has seen before',
    'Yes, for this session only', 'Allow this session only', 'Yes, allow reading from this project only', 'Yes, allow once and remember', "Yes, and don't ask again, just once more", // QA Reviewer 2's round 2: a wider reach with an only or a once
    "Yes (for this session's command only)", // ambiguous: set apart (a reach, not unsafe)
];
const ONE_TIME = [
    'Yes', 'Yes, proceed', 'Yes, proceed (y)', 'Allow', 'Allow once', 'Allow once only', 'Yes, just this once', 'Yes, this time', 'Approve', 'OK', 'Proceed', 'Yes, once only', 'Yes, this one time only', 'Yes, allow this one time', 'Yes, run command',
    'No', 'No, and tell Claude what to do differently (esc)', 'No, and tell Codex what to do differently (esc)', 'Deny', 'Cancel', 'Reject',
    'No, and tell it why it must not be allowed during this session', "No, don't ask again later today?", 'No, keep asking', 'Esc',
];
for (const l of STANDING) assert.equal(isOneTime(l), false, `standing: ${l}`);
for (const l of ONE_TIME) assert.equal(isOneTime(l), true, `one-time: ${l}`);

// a card's options: each list at once
assert.deepEqual(standingOptions(STANDING.map(label => ({ label }))).map(o => o.label), STANDING, 'each standing label is apart');
assert.deepEqual(standingOptions(ONE_TIME.map(label => ({ label }))), [], 'no one-time label is');
// the real cards
for (const [opts, apart] of [
    [['Yes', "Yes, and don't ask again for go test commands", 'No'], ["Yes, and don't ask again for go test commands"]],
    [['Allow once', 'Allow for this session', 'Allow for all future sessions', 'No'], ['Allow for this session', 'Allow for all future sessions']],
    [['Yes, proceed (y)', "Yes, and don't ask again for this command (p)", 'No, and tell Codex what to do differently (esc)'], ["Yes, and don't ask again for this command (p)"]],
    [['Yes', 'No'], []],
]) assert.deepEqual(standingOptions(opts.map(label => ({ label }))).map(o => o.label), apart, opts.join(' | '));
// the bar of a card never holds a standing label
for (const opts of [STANDING.concat(ONE_TIME), ONE_TIME.concat(STANDING)]) {
    const os = opts.map(label => ({ label })), apart = new Set(standingOptions(os)), bar = os.filter(o => !apart.has(o));
    assert.ok(bar.every(o => ONE_TIME.includes(o.label)), 'the bar holds one-time answers only');
}
assert.deepEqual(standingOptions(null), []); assert.equal(isOneTime(undefined), true);
console.log('standing_option: ok');
