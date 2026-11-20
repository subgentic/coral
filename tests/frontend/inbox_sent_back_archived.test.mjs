import assert from 'node:assert/strict';
import test from 'node:test';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom();
const { sentBackChip, producerArchived } = await importUi('inbox_review_state');
// #19897: a file sent back to an archived agent says so: "waiting on" an agent that is gone is not true, and the Operator reads it as "the agent is working on it".
test('the chip of a sent-back file says the agent is archived, and otherwise waits on it', () => {
  assert.equal(sentBackChip('Video Producer').textContent, 'Sent back');
  const gone = sentBackChip('Video Producer', true);
  assert.equal(gone.textContent, 'Sent back · Video Producer is archived');
  assert.doesNotMatch(gone.textContent, /waiting on/);
  assert.match(gone.title, /nobody is working on it/);
});
test('only an archived agent of the row is archived: an asleep or awake one, another agent or no list is not', () => {
  const row = { session_id: 'a1' };
  assert.equal(producerArchived(row, [{ session_id: 'a1', archived: true }]), true);
  assert.equal(producerArchived(row, [{ session_id: 'a1', sleeping: true }]), false, 'asleep is woken by the send-back, not archived');
  assert.equal(producerArchived(row, [{ session_id: 'a2', archived: true }]), false);
  assert.equal(producerArchived(row, undefined), false);
  assert.equal(producerArchived({}, [{ session_id: 'a1', archived: true }]), false);
});
