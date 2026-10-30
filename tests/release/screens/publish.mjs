// Files a run on the board: the release task "UI review: vX.Y.Z", the contact sheet and every shot as Coral artifacts on it. A plain script: coral-board and coral-agent are called as a CLI under the
// identity of whoever runs it (the operator's or DevOps's), no agent turn and no model is involved.
//   node publish.mjs --out DIR --version 2.0.7 --sha SHA [--prev DIR] [--goal 163] [--assignee Operator] [--task N] [--all] [--dry-run]
// The link of an artifact is the SHA-256 of its bytes, so every link is known before anything is uploaded: the contact sheet (which links every shot) goes up FIRST, then the shots, and each
// upload's answer is checked against the link the sheet holds. Nothing here ever blocks a release: a failure is reported and the exit code says so, and run.sh only warns.
//
// The server lets an agent session upload 100 files an hour (512 MiB), refused ones included, so the script paces itself: SCREENS_UPLOADS_PER_HOUR (default 80, leaving the rest to whoever runs it) and,
// when the server says "rate limited", it waits the Retry-After and goes on (SCREENS_MAX_WAIT_MIN, default 300, bounds the waiting). A run after the first uploads only the shots that CHANGED or are new:
// an unchanged page links to the previous release's artifact (links.json of that release), so a release's filing is a few dozen files, not every page again. --all uploads every shot.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildManifest, taskBody, taskTitle, expectedLink, artifactName } from './manifest.mjs';
import { buildSheet } from './sheet.mjs';

const arg = name => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
const flag = name => process.argv.includes('--' + name);
const out = arg('out'), version = arg('version'), sha = arg('sha') || 'unknown', prevDir = arg('prev'), goal = arg('goal') || process.env.SCREENS_GOAL || '163', assignee = arg('assignee') || process.env.SCREENS_ASSIGNEE || 'Operator';
const dry = flag('dry-run'), all = flag('all');
const perHour = Number(process.env.SCREENS_UPLOADS_PER_HOUR || 80), maxWaitMs = Number(process.env.SCREENS_MAX_WAIT_MIN || 300) * 60000;
if (!out || !version) { console.error('usage: publish.mjs --out DIR --version X.Y.Z --sha SHA [--prev DIR] [--goal 163] [--assignee Operator] [--task N] [--all] [--dry-run]'); process.exit(2); }
const bin = program => (process.env.SCREENS_BIN ? path.join(process.env.SCREENS_BIN, program) : program);
const log = (...a) => console.error('[publish]', ...a);

function call(program, args, { allowFail = false } = {}) {
    const r = spawnSync(bin(program), args.map(String), { encoding: 'utf8', timeout: 60000 });
    if (r.error) throw new Error(`${program}: ${r.error.message}`);
    if (r.status !== 0 && !allowFail) throw new Error(`${program} ${args.slice(0, 3).join(' ')}: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`);
    return r;
}

const results = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
const changes = fs.existsSync(path.join(out, 'changes.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'changes.json'), 'utf8')).rows : null;
const ranAt = results.ranAt || new Date().toISOString();
const manifest = buildManifest({ version, sha, ranAt, widths: results.widths, themes: results.themes, results: results.results, changes });
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

// Every link, before any upload. An unchanged shot is not uploaded again (unless --all): it keeps the link it had in the previous release, if that release recorded one.
const prevLinks = prevDir && fs.existsSync(path.join(prevDir, 'links.json')) ? JSON.parse(fs.readFileSync(path.join(prevDir, 'links.json'), 'utf8')) : {};
const links = {}, toUpload = [];
for (const a of manifest.artifacts) {
    if (!all && a.status === 'unchanged') { links[a.name] = prevLinks[a.name] || ''; continue; }
    links[a.name] = expectedLink(fs.readFileSync(path.join(out, a.file)));
    toUpload.push(a);
}
const sheetFile = path.join(out, 'contact-sheet.html');
const writeSheet = () => fs.writeFileSync(sheetFile, buildSheet({ manifest, links, dir: out, prevDir: prevDir && fs.existsSync(prevDir) ? prevDir : null }));
writeSheet();
const sheetName = `UI review ${manifest.tag}: contact sheet.html`;
let sheetLink = expectedLink(fs.readFileSync(sheetFile));
log(`${manifest.shotCount} shots, ${manifest.pageCount} pages, ${manifest.failed.length} not photographed; ${toUpload.length} to upload; sheet ${(fs.statSync(sheetFile).size / 1e6).toFixed(1)} MB`);
if (dry) {
    fs.writeFileSync(path.join(out, 'published.json'), JSON.stringify({ dryRun: true, title: taskTitle(version), body: taskBody(manifest, sheetLink), sheetLink }, null, 2));
    log('dry run: nothing uploaded; see manifest.json, contact-sheet.html, published.json');
    process.exit(0);
}

const published = { title: taskTitle(version), task: null, sheet: null, uploaded: 0, planned: toUpload.length, mismatched: [], failed: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamps = [];
let waited = 0;
/** Waits for room under the hourly count (this script's own, kept below the server's), then notes the upload. */
async function room() {
    const now = Date.now();
    while (stamps.length && now - stamps[0] > 3600000) stamps.shift();
    if (stamps.length >= perHour) {
        const ms = stamps[0] + 3600000 - now + 5000;
        if (waited + ms > maxWaitMs) throw new Error(`stopped after waiting ${Math.round(waited / 60000)} min for the hourly upload limit (SCREENS_MAX_WAIT_MIN)`);
        log(`waiting ${Math.ceil(ms / 60000)} min: ${perHour} uploads in the last hour (the server allows 100 an hour per agent)`);
        await sleep(ms); waited += ms;
        return room();
    }
    stamps.push(Date.now());
}
try {
    // The task: --task N, else the open one named for this release that is the runner's, else a new one if this identity may create tasks. It is the runner's while the files go up (an upload links only to
    // a task of its own); a runner that may reassign (the orchestrator, the Operator) hands it to the assignee after, any other completes it with the contact sheet's link in the message.
    const title = taskTitle(version);
    const me = process.env.CORAL_SUBSCRIBER_ID || '';
    let id = Number(arg('task') || 0) || null;
    if (!id) {
        const list = JSON.parse(call('coral-board', ['task', 'list', '--json']).stdout || '[]');
        const open = (Array.isArray(list) ? list : list.tasks || []).filter(t => t.title === title && !['completed', 'cancelled'].includes(t.status));
        const mine = open.find(t => t.assigned_to === me);
        if (mine) id = mine.id;
        else if (open.length) throw new Error(`the task #${open[0].id} "${title}" is assigned to ${open[0].assigned_to || 'nobody'}, not to ${me || 'this runner'}: run as that one, pass --task N, or have it reassigned`);
    }
    if (!id) {
        const add = call('coral-board', ['task', 'add', title, '--goal', goal, '--body', taskBody(manifest, sheetLink), '--priority', 'medium', ...(me ? ['--assignee', me] : [])], { allowFail: true });
        if (add.status !== 0) throw new Error(`this identity cannot create the task (${(add.stderr || add.stdout || '').trim().split('\n')[0]}). Ask the orchestrator to create "${title}" on goal #${goal} assigned to ${me || 'the runner'}, then run again (or pass --task N)`);
        id = Number((add.stdout.match(/Created Task #(\d+)/) || [])[1]);
        if (!id) throw new Error('no task id in: ' + add.stdout.trim().slice(0, 120));
    }
    call('coral-board', ['task', 'claim', id], { allowFail: true }); // a task still pending is the runner's to claim; one in progress already is fine
    published.task = id;
    const upload = async (file, name, extra = []) => {
        for (;;) {
            await room();
            const r = call('coral-agent', ['artifact', 'upload', file, '--name', name, '--task', id, '--tag', 'ui review', ...extra], { allowFail: true });
            if (r.status !== 0) {
                const text = (r.stderr || r.stdout || '').trim();
                const retry = text.match(/Retry-After: (\d+)/);
                if (/rate limited/.test(text) && retry && waited + Number(retry[1]) * 1000 <= maxWaitMs) { // the server's own limit was reached (another upload of this agent, or the hour's window): wait it out
                    log(`the server's hourly limit: waiting ${Math.ceil(Number(retry[1]) / 60)} min`);
                    await sleep((Number(retry[1]) + 5) * 1000); waited += (Number(retry[1]) + 5) * 1000; stamps.length = 0;
                    continue;
                }
                return { error: text.split('\n')[0] };
            }
            try { return JSON.parse(r.stdout.trim().split('\n').filter(l => l.startsWith('{')).pop()); } catch { return { error: 'unreadable answer: ' + r.stdout.slice(0, 80) }; }
        }
    };
    // 1. the sheet, first
    const s = await upload(sheetFile, sheetName);
    if (s.error) throw new Error('the contact sheet was not uploaded: ' + s.error);
    published.sheet = s.uri;
    // 2. the shots
    for (const a of toUpload) {
        const r = await upload(path.join(out, a.file), a.name);
        if (r.error) { published.failed.push({ name: a.name, error: r.error }); continue; }
        published.uploaded++;
        if (r.uri !== links[a.name]) { published.mismatched.push(a.name); links[a.name] = r.uri; }
    }
    // 3. a link that was not what the sheet holds (the server rewrote an image): the sheet again, as a new version of the first
    if (published.mismatched.length) {
        writeSheet();
        const v = await upload(sheetFile, sheetName, ['--new-version-of', published.sheet]);
        if (v.error) log('the corrected sheet was not uploaded:', v.error); else published.sheet = v.uri;
    }
    const handed = call('coral-board', ['task', 'reassign', id, '--to', assignee], { allowFail: true });
    if (handed.status !== 0) { // this runner may not reassign: the task is completed with the contact sheet in its message, which is where the Operator reads the result
        call('coral-board', ['task', 'complete', id, '--message', taskBody(manifest, published.sheet)], { allowFail: true });
        published.completed = true;
    }
    log(`task #${id}: ${published.uploaded} of ${toUpload.length} shots uploaded (${manifest.shotCount - toUpload.length} unchanged shots keep the previous release's link), sheet ${published.sheet}`);
} catch (e) {
    published.failed.push({ name: 'run', error: String(e.message || e) });
    log('FAILED:', published.failed.at(-1).error);
}
fs.writeFileSync(path.join(out, 'published.json'), JSON.stringify(published, null, 2));
fs.writeFileSync(path.join(out, 'links.json'), JSON.stringify(Object.fromEntries(Object.entries(links).filter(([, v]) => v)), null, 2)); // the next release's unchanged shots link here
process.exit(published.failed.length ? 1 : 0);
