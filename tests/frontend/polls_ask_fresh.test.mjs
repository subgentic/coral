// #9165: the reads that wait for a change ask fresh, so the one-second sharing of the load's repeated reads (fetch_share.js, #9111) never answers them with the state before. The first-launch check
// asks the connector's status ten times while it loads, and the distillation's poll and refresh read the run's progress; run 145c's editions and knowledge_distill suites failed on the shared answers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL('../../coral-go/pkg/frontend/static/' + f, import.meta.url), 'utf8');
const SHARED = read('fetch_share.js');
assert.ok(/\/\^\\\/api\\\/cloud\\\/status\$\//.test(SHARED) && /distill-knowledge/.test(SHARED), 'fetch_share still names the two routes this guards (if it stops sharing them, this test can go)');

const editions = read('editions.js');
const loop = editions.slice(editions.indexOf('LOADING_TRIES; i++'));
assert.ok(/fetch\('\/api\/cloud\/status', \{ cache: 'no-store' \}\)/.test(loop.slice(0, 400)), "editions.js: the first-launch check's loading poll asks fresh");

const distill = read('knowledge_distill.js');
const fn = distill.slice(distill.indexOf('async function _fetchStatus'), distill.indexOf('function _stopPoll'));
assert.ok(/teamFetch\(team, path, \{ cache: 'no-store' \}\)/.test(fn), "knowledge_distill.js: the distillation's status read (its poll and its refresh) asks fresh");
console.log('polls_ask_fresh: ok');
