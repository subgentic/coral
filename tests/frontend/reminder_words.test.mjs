// A chat's Coral reminders read as sentences for a person (#10376): the command an agent runs is not shown. Pure functions (reminder_words.js).
import assert from 'node:assert/strict';
import { reminderWords } from '../../coral-go/pkg/frontend/static/reminder_words.js';

assert.equal(reminderWords("You have 1 unread message on the message board. Run 'coral-board read' to see them."), 'You have 1 unread message on the message board.');
assert.equal(reminderWords("You have 3 unread messages on the message board. Run 'coral-board read' to see them."), 'You have 3 unread messages on the message board.');
assert.equal(reminderWords("[Task #1 available] Run 'coral-board task claim 1' to claim it when your current task is done."), 'Task #1 is available.');
assert.equal(reminderWords("[Task #12 (high) available] Run 'coral-board task claim 12' to claim it when your current task is done."), 'Task #12 is available (high priority).');
assert.equal(reminderWords('Coral is restarting.'), 'Coral is restarting.', 'any other reminder is as it was');
assert.equal(reminderWords(''), '', 'nothing stays nothing');
console.log('reminder_words: ok');
