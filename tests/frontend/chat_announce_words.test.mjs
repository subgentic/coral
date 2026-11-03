// #12426: the reply a screen reader hears ("<agent> replied: ...") shows the agent's text as written. Its underscores were all removed as if they were Markdown emphasis: HERMES_TEST_REPLY was said and shown as HERMESTESTREPLY.
// An underscore inside a word is the word's; one that wraps a word as emphasis (_so_) goes, as do backticks, asterisks and a line's leading # or >.
import assert from 'node:assert/strict';
import { importUi } from './helpers/jsdom_env.mjs';
const { words } = await importUi('chat_announce'); // importUi converts the native path with pathToFileURL (Windows drive letters are not URL schemes)
const cases = [
    ['HERMES_TEST_REPLY', 'HERMES_TEST_REPLY'],
    ['the file snake_case_name.py changed', 'the file snake_case_name.py changed'],
    ['call __init__ now', 'call __init__ now'.replace('__init__', 'init')], // a whole word wrapped in underscores is emphasis
    ['this is _very_ good', 'this is very good'],
    ['this is __very__ good.', 'this is very good.'],
    ['**bold** and `code_with_underscore`', 'bold and code_with_underscore'],
    ['# Heading\n> quoted_line', 'Heading quoted_line'],
    ['a_b _c_ d_e_f', 'a_b c d_e_f'],
];
for (const [input, want] of cases) assert.equal(words(input), want, JSON.stringify(input));
assert.equal(words('x'.repeat(200)).length, 121, 'still cut at 120 characters with an ellipsis'); // 120 + the ellipsis
console.log('chat_announce_words: ok');
