// What Coral types into an agent and the dashboard's isCoralNudge (#10125, Security Reviewer's LOW on #10046): the Go side (agent.IsCoralDelivery) and this one keep their own lists of patterns, and both are
// tested against the one fixture, coral-go/internal/agent/testdata/coral_deliveries.json, so a new notice wording added there fails whichever side does not know it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
installDom({ mode: 'local' });
const { isCoralNudge } = await importUi('pending_messages');
const { unwrapPastedContent } = await importUi('pasted_content');
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../coral-go/internal/agent/testdata/coral_deliveries.json');
const cases = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.ok(cases.notices.length > 10 && cases.not_notices.length > 5, 'the fixture has its cases');
// the chat reads a turn the way chat_messages.js does: a paste's tags taken off first
const nudge = text => isCoralNudge(unwrapPastedContent(text));
for (const text of cases.notices) assert.equal(nudge(text), true, `a notice: ${JSON.stringify(text)}`);
for (const text of cases.not_notices) assert.equal(nudge(text), false, `not a notice: ${JSON.stringify(text)}`);
console.log(`coral_notice_fixture: ok (${cases.notices.length} notices, ${cases.not_notices.length} not)`);
