// #12754: each surface fixture calls its actual production builder.
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, 'resize_cases');
const CASES = Object.fromEntries(fs.readdirSync(dir).filter(n => n.endsWith('.js')).sort().map(n => [n.slice(0, -3), require(path.join(dir, n))]));
module.exports = { CASES };
