// #10597: what a screen reader hears of an agent's reply keeps the words as written: an underscore inside a word stays ("retry_count"), emphasis marks at a word's edge go.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom();
const { words } = await importUi('chat_announce');
assert.equal(words('Fixed retry_count in task_runner.py'), 'Fixed retry_count in task_runner.py', 'underscores inside words stay');
assert.equal(words('It is **done** and _checked_ and __sure__'), 'It is done and checked and sure', 'emphasis marks go');
assert.equal(words('## Result\n\n`MAX_RETRIES` is 3'), 'Result MAX_RETRIES is 3', 'a heading mark and backticks go, the constant stays');
assert.equal(words(null), '');
assert.equal(words('word '.repeat(60)).endsWith('…'), true, 'a long reply is still cut');
console.log('chat_announce_words: ok');
