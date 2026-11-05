import assert from 'node:assert/strict';
import fs from 'node:fs';
import { activityWords, jobRunParts } from '../../coral-go/pkg/frontend/static/operator_activity_words.js';
import { ACTION_LABEL, ACTIONS } from '../../coral-go/pkg/frontend/static/operator_activity_filters.js';
assert.equal(activityWords({action:'answer',item_kind:'question',title:'Ada',note:'Ship it'}), 'You answered Ada’s question: “Ship it”');
assert.equal(activityWords({action:'answer',item_kind:'question',note:'Yes'}), 'You answered a question: “Yes”');
assert.equal(activityWords({action:'prompt_allow',item_id:'claude-ada',note:'Yes, once'}), 'You allowed claude-ada’s permission request: “Yes, once”');
assert.equal(activityWords({action:'prompt_reject',item_id:'claude-ada',note:'No'}), 'You refused claude-ada’s permission request: “No”');
assert.equal(activityWords({action:'prompt_answer',item_id:'old-agent'}), 'You answered old-agent’s permission prompt');
assert.equal(activityWords({action:'task_complete',item_id:'12',title:'Ship release'}), 'You completed task #12 Ship release');
const boardDir = new URL('../../coral-go/internal/board/',import.meta.url);
const constants = fs.readdirSync(boardDir).filter(n=>n.endsWith('.go')&&!n.endsWith('_test.go')).map(n=>fs.readFileSync(new URL(n,boardDir),'utf8')).join('\n');
const values = new Map([...constants.matchAll(/\b(Act\w+)\s*=\s*"([^"]+)"/g)].map(m=>[m[1],m[2]]));
const routes = fs.readFileSync(new URL('../../coral-go/internal/server/routes/operator_activity.go',import.meta.url),'utf8');
const registered = routes.slice(routes.indexOf('var activityActions'),routes.indexOf('// recordActivity'));
for(const [,name] of registered.matchAll(/board\.(Act\w+):\s*true/g)) {
    const value=values.get(name);
    assert.ok(value && ACTION_LABEL[value], `Recorded ${name} (${value}) needs Activity words and filter`);
    assert.ok(ACTIONS.includes(value));
    assert.ok(activityWords({action:value,item_kind:'task',item_id:'12',title:'Title'}) !== value, value);
}
console.log('operator_activity_words: summaries, historical fallbacks and every recorded action covered');

assert.deepEqual(jobRunParts('41:73'), {jobId:41,runId:73});
for(const id of ['73','0:73','41:0','-1:2','1:2:3','1.5:2','1e2:3','9007199254740992:1','1:9007199254740992']) assert.equal(jobRunParts(id), null, id);
console.log('job-run ids preserve unequal parent/run ids and reject unsafe historical values');
