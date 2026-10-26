import assert from 'node:assert/strict';
import { plural } from '../../coral-go/pkg/frontend/static/format.js';
for (const [n, want] of [[0,'0 tasks'],[1,'1 task'],[2,'2 tasks'],[1.5,'1.5 tasks'],[-1,'-1 tasks'],['1','1 tasks']]) assert.equal(plural(n,'task'),want);
assert.equal(plural(1,'person','people'),'1 person');
assert.equal(plural(2,'person','people'),'2 people');
assert.equal(plural('1','file','files',{localized:true}),'1 file');
assert.equal(plural(1234,'file','files',{localized:true}),`${(1234).toLocaleString()} files`);
assert.equal(`${plural(2,'minute')} ago`,'2 minutes ago');
console.log('plural: zero, one, fractions, irregular words and localized counts preserved');
