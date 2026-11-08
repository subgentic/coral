import assert from 'node:assert/strict';
import fs from 'node:fs';
import { activityParts, cleanAnswer, jobRunParts } from '../../coral-go/pkg/frontend/static/operator_activity_words.js';
import { ACTION_LABEL, ACTIONS } from '../../coral-go/pkg/frontend/static/operator_activity_filters.js';
const boardDir = new URL('../../coral-go/internal/board/',import.meta.url);
const constants = fs.readdirSync(boardDir).filter(n=>n.endsWith('.go')&&!n.endsWith('_test.go')).map(n=>fs.readFileSync(new URL(n,boardDir),'utf8')).join('\n');
const values = new Map([...constants.matchAll(/\b(Act\w+)\s*=\s*"([^"]+)"/g)].map(m=>[m[1],m[2]]));
const routes = fs.readFileSync(new URL('../../coral-go/internal/server/routes/operator_activity.go',import.meta.url),'utf8');
const registered = routes.slice(routes.indexOf('var activityActions'),routes.indexOf('// recordActivity'));
for(const [,name] of registered.matchAll(/board\.(Act\w+):\s*true/g)) {
    const value=values.get(name);
    assert.ok(value && ACTION_LABEL[value], `Recorded ${name} (${value}) needs Activity words and filter`);
    assert.ok(ACTIONS.includes(value));
    assert.ok(activityParts({action:value,item_kind:'task',item_id:'12',title:'Title'}, r => r.title).did, value);
}
console.log('operator_activity_words: every recorded action has words and a filter');

assert.deepEqual(jobRunParts('41:73'), {jobId:41,runId:73});
for(const id of ['73','0:73','41:0','-1:2','1:2:3','1.5:2','1e2:3','9007199254740992:1','1:9007199254740992']) assert.equal(jobRunParts(id), null, id);
console.log('job-run ids preserve unequal parent/run ids and reject unsafe historical values');

// #14423: one rule: the verb in YOU DID, the object in ON, the detail on its own line
const words = r => r.title || ({ file: 'a file', question: 'a question' }[r.item_kind]) || 'an item';
assert.deepEqual(activityParts({action:'answer',item_kind:'question',title:'Orchestrator',note:'@Orchestrator Option 2'}, words), {did:'Answered',on:'Orchestrator’s question',detail:'Your answer: Option 2'}, 'an old row keeps the asker in the title; the answer has no raw @mention');
assert.deepEqual(activityParts({action:'answer',item_kind:'question',title:'Which release?',asker:'Orchestrator',note:'@Orchestrator 1 is fine for now'}, words), {did:'Answered',on:'Which release?',detail:'from Orchestrator · Your answer: 1 is fine for now'}, 'a new row: the ask is the object, the asker is in the detail');
assert.deepEqual(activityParts({action:'answer',item_kind:'question',note:'Yes'}, words), {did:'Answered',on:'a question',detail:'Your answer: Yes'});
assert.deepEqual(activityParts({action:'dismiss',item_kind:'question',note:'Dismissed by the operator'}, words), {did:'Dismissed',on:'a question',detail:''}, 'no Dismissed Dismissed by: the fixed note is not repeated');
assert.deepEqual(activityParts({action:'dismiss',item_kind:'question',title:'Ship it?',note:'Not now, the build is red and I want to look at it first'}, words), {did:'Dismissed',on:'Ship it?',detail:'Not now, the build is red and I want to look at it first'}, 'any other note is whole, on its own line');
assert.deepEqual(activityParts({action:'file_star',item_kind:'file',title:'plan.md'}, words), {did:'Starred',on:'plan.md',detail:''}, 'a starred file shows its name');
assert.deepEqual(activityParts({action:'file_unstar',item_kind:'file'}, words), {did:'Unstarred',on:'a file',detail:''}, 'an older row falls back to the kind');
assert.deepEqual(activityParts({action:'task_complete',item_id:'12',title:'Ship release',note:'done'}, words), {did:'Completed',on:'task #12 Ship release',detail:'done'});
assert.deepEqual(activityParts({action:'approve',item_kind:'file',title:'plan.md'}, words), {did:'Approved',on:'plan.md',detail:''});
assert.equal(cleanAnswer('@Orchestrator Option 2', 'Orchestrator'), 'Option 2', 'the recorded asker\u2019s mention goes');
assert.equal(cleanAnswer('@orchestrator, Option 2', 'Orchestrator'), 'Option 2', 'in any case, with a comma');
assert.equal(cleanAnswer('@Head of Security fine by me', 'Head of Security'), 'fine by me', 'a name of several words goes whole');
assert.equal(cleanAnswer('@Lead go ahead', 'Orchestrator'), '@Lead go ahead', 'another mention at the start is part of the answer');
assert.equal(cleanAnswer('@Orchestrator @Lead go ahead', 'Orchestrator'), '@Lead go ahead', 'only the asker\u2019s is removed');
assert.equal(cleanAnswer('@Headline fine', 'Head'), '@Headline fine', 'a name that is only the start of a longer word is not removed');
assert.equal(cleanAnswer('@Orchestrator Option 2'), '@Orchestrator Option 2', 'no asker known: the note is shown as it is');
assert.equal(cleanAnswer('@Orchestrator', 'Orchestrator'), '@Orchestrator', 'a note that is only the mention is kept');
assert.equal(cleanAnswer('@Orchestrator (a+b) ok', 'Orchestrator'), '(a+b) ok');
assert.equal(cleanAnswer('@A.B ok', 'A.B'), 'ok', 'regex characters in a name are plain');
assert.deepEqual(activityParts({action:'answer',item_kind:'question',title:'Which?',asker:'Head of Security',note:'@Head of Security yes'}, words).detail, 'from Head of Security · Your answer: yes');
assert.deepEqual(activityParts({action:'answer',item_kind:'question',title:'Which?',asker:'Orchestrator',note:'@Lead yes'}, words).detail, 'from Orchestrator · Your answer: @Lead yes', 'an unrelated mention stays in the detail');
for (const value of ACTIONS) { const p = activityParts({action:value,item_kind:'task',item_id:'12',title:'Title'}, words); assert.ok(p.did && p.on, value); }
console.log('operator_activity_words: verb, object and detail for each row');
