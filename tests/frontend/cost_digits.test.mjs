// How many decimals a column of costs needs (#10740): cents unless two different costs would read the same, then three, then four.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';

installDom({ mode: 'local' });
const F = await importUi('format');
assert.equal(F.costDigits([2.5, 0.4]), 2);
assert.equal(F.costDigits([1.2312, 1.2349]), 3);
assert.equal(F.costDigits([1.2312, 1.2318]), 3);
assert.equal(F.costDigits([1.23121, 1.23124]), 4, "four is the most it shows");
assert.equal(F.costDigits([1.5, 1.5]), 2, 'the same cost twice is not a tie');
assert.equal(F.costDigits([0.0042, 0.0049, 0]), 2, 'a cost under a cent already shows four decimals');
assert.equal(F.costDigits([]), 2);
assert.equal(F.formatCost(1.2312, { zeroAsTwo: true, digits: 3 }), '$1.231');
assert.equal(F.formatCost(1.2312, { zeroAsTwo: true }), '$1.23');
assert.equal(F.formatCost(0.0042, { zeroAsTwo: true, digits: 3 }), '$0.0042');
console.log('cost_digits: ok');
