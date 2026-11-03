// #12754: every desktop one-line data table opts into shared column resizing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as espree from 'espree';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../coral-go/pkg/frontend/static');
const errors = []; let tables = 0, phoneOnly = 0;
const walk = (node, visit) => { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) { node.forEach(n => walk(n, visit)); return; } visit(node); for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value, visit); };
for (const file of fs.readdirSync(root).filter(f => f.endsWith('.js'))) {
    const tree = espree.parse(fs.readFileSync(path.join(root,file),'utf8'), { ecmaVersion: 'latest', sourceType: 'module', loc: true });
    walk(tree, node => {
        if (node.type !== 'ObjectExpression') return;
        const prop = key => node.properties.find(p => p.type === 'Property' && (p.key.name || p.key.value) === key);
        if (prop('oneLine')?.value.value !== true) return;
        if (file === 'analytics_views.js') { phoneOnly++; return; } // phoneOneLine returns this only after isPhoneLayout(); desktop Analytics already resizes.
        tables++;
        if (prop('resize')?.value.value !== true) errors.push(`${file}:${node.loc.start.line}: one-line desktop table must set resize: true`);
    });
}
assert.equal(phoneOnly,1,'the one phone-only Analytics helper is the sole intentional exception');
assert.deepEqual(errors,[],'desktop tables must retain the shared resize contract');
console.log(`one_line_resize_census: ok (${tables} desktop one-line tables, 1 phone-only helper)`);
