import fs from 'node:fs';
import assert from 'node:assert/strict';
const source = fs.readFileSync(new URL('../../coral-go/pkg/frontend/static/coral_ref.js', import.meta.url),'utf8');
const { parseCoralRef, coralRefUri } = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
for (const value of ['coral://artifacts/'+'a'.repeat(64),'coral://goals/team-a/12','coral://diffs/team-a/abc123-id/0123456789abcdef']) assert.equal(coralRefUri(parseCoralRef(value)),value);
for (const value of ['coral://goals/../12','coral://goals/team/012','coral://goals/team/0','coral://goals/team/1/extra','coral://goals/team%2fa/1','coral://diffs/team/short/0123456789abcdef','coral://diffs/team/abcdef/0123456789abcdef0','coral://artifacts/'+'a'.repeat(65),'coral://unknown/a','javascript:alert(1)','coral://goals/team/1?run=command','coral://goals/team/1#x']) assert.equal(parseCoralRef(value),null,value);
console.log('PASS closed Coral reference grammar');
