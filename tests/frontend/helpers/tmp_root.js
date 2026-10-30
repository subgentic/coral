// The folder a suite makes its scratch folders in: /tmp where there is one (short paths: a unix socket's path has a length limit, and a Mac's os.tmpdir() is a long /var/folders/... one), the system's temp folder on
// Windows, which has no /tmp (#11045: `ENOENT mkdtemp '/tmp/att-XXXXXX'` on windows-tests).
const os = require('node:os');
module.exports = process.platform === 'win32' ? os.tmpdir() : '/tmp';
