// A folder that exists on every platform, for a suite that types a folder into the launch dialogs (#14596). Since acfb782ec the New team dialog's Next checks the folder before it advances, and a Unix
// path such as /tmp/census-project does not exist on Windows, so a suite that typed one stayed on step 1 there. teamDir(name) makes <a SHORT base>/cu-<random>/<name> (once per process, removed when the
// suite ends) and returns its native path; embed it in page code with JSON.stringify(teamDir('x')), which escapes a Windows path's backslashes. The base is short on purpose: a long folder label wraps at 200%
// text and the text200 suites flag it (macOS's /var/folders/... and Windows' C:\Users\<user>\AppData\Local\Temp\... are both long). So: /tmp where there is one; on Windows the root of the system drive
// (C:\cu-xxxxxx), and the OS's temp folder only if that root is not writable.
'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
let root = null;
function teamDir(name) {
    if (!root) {
        const fresh = base => fs.mkdtempSync(path.join(base, 'cu-'));
        if (process.platform !== 'win32') root = fresh('/tmp');
        else {
            try { root = fresh(`${process.env.SystemDrive || 'C:'}\\`); } catch { root = fresh(os.tmpdir()); } // the drive's root may not be writable for this user: the temp folder is long but works
        }
        process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* already gone */ } });
    }
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
module.exports = { teamDir };
