// #10641: a chat row's search hit shows the match once and never repeats the row's own title ("Three day plan. plan a trip to lisbon Three day plan." under the title "Three day plan.").
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom();
const { hitWithoutTitle } = await importUi('history_label');
const row = (title, snippet) => ({ session_id: 's1', title, snippet });
assert.equal(hitWithoutTitle(row('Three day plan.', 'Three day plan. plan a trip to lisbon Three day plan.')), 'plan a trip to lisbon', 'the title is not read twice');
assert.equal(hitWithoutTitle(row('Three day plan.', 'plan a trip to lisbon')), 'plan a trip to lisbon', 'a hit without the title is as it was');
assert.equal(hitWithoutTitle(row('Three day plan.', 'Three day plan.')), '', 'a hit that is only the title leaves nothing for the row to repeat');
assert.equal(hitWithoutTitle(row('Fix the build', 'fix the build, then FIX THE BUILD again: retry_count is 3')), 'then again: retry_count is 3', 'case does not matter; the person\'s other words stay');
assert.equal(hitWithoutTitle(row('A (draft) [v2] + more?', 'see A (draft) [v2] + more? and the notes')), 'see and the notes', 'a title with regular-expression marks is matched as text');
// only the whole title, on word edges: a short title is a word inside other words (Security, #10641 round 1)
assert.equal(hitWithoutTitle(row('Plan', 'we are planning a trip to plan')), 'we are planning a trip to', 'planning keeps its letters');
assert.equal(hitWithoutTitle(row('Fix', 'prefix the suffix and fix it')), 'prefix the suffix and it', 'prefix and suffix keep theirs');
assert.equal(hitWithoutTitle(row('a', 'a cat sat on a mat')), 'cat sat on mat', 'the one-letter title goes only as a word');
assert.equal(hitWithoutTitle(row('Notes', 'my_notes and Notes2 and notes.')), 'my_notes and Notes2 and', 'a letter, a digit or an underscore beside it makes it part of another word');
assert.equal(hitWithoutTitle(row('Plan', '')), '');
assert.equal(hitWithoutTitle(null), '');
console.log('history_hit: ok');
