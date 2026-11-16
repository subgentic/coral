// tests/stress/cpu_load.sh (#18213): its busy loops end on their own. The old recipe's loops outlived a killed shell by a day (24 of them, load ~50 on the Mac); these must not.
// Starts the helper from a shell, kills that shell with SIGKILL, and asserts no loop survives 5 s; also the time cap, an explicit owner, and a refused argument.
if (process.platform === 'win32') { console.log('cpu_load: skipped on Windows (a POSIX shell script)'); process.exit(0); }
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, spawnSync } = require('./helpers/child_process');
const SH = path.join(__dirname, '..', 'stress', 'cpu_load.sh');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(200); /* sleep-ok: a poll step of until() */ } return fn(); };
const all = [];
const track = pids => { all.push(...pids); return pids; };
const pidsOf = out => out.trim().split(/\s+/).filter(Boolean).map(Number);

(async () => {
    try {
        // 1. the owner shell is killed with SIGKILL: no loop survives 5 s
        const owner = spawn('sh', ['-c', `sh ${SH} 3 600; exec sleep 300`], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        owner.stdout.on('data', d => { out += d; });
        assert.ok(await until(() => out.includes('\n'), 5000), 'the helper printed the PIDs');
        const pids = track(pidsOf(out));
        assert.equal(pids.length, 3, 'one PID per loop: ' + out);
        assert.ok(pids.every(alive), 'the loops run while the owner lives');
        await sleep(2500); // sleep-ok: the loops must still run after a few of their one-second owner checks
        assert.ok(pids.every(alive), 'and keep running while the owner lives (past a check or two)');
        owner.kill('SIGKILL');
        assert.ok(await until(() => pids.every(p => !alive(p)), 5000), 'no loop survives 5 s after its owner is killed: ' + pids.filter(alive));

        // 2. the time cap, owner still alive: 2 loops, 2 s
        const cap = spawnSync('sh', [SH, '2', '2'], { encoding: 'utf8' });
        assert.equal(cap.status, 0, cap.stderr);
        const capped = track(pidsOf(cap.stdout));
        assert.equal(capped.length, 2);
        assert.ok(await until(() => capped.every(p => !alive(p)), 6000), 'the loops stop after SECONDS at most');

        // 2b. a loop killed early takes its watcher with it (within a second or two): the watcher never lives on to signal a PID that was reused (#18223)
        const early = spawnSync('sh', [SH, '2', '4321'], { encoding: 'utf8' });
        const earlyP = track(pidsOf(early.stdout));
        assert.equal(earlyP.length, 2);
        const watchers = () => spawnSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).stdout.split('\n').filter(l => l.includes('cpu_load.sh 2 4321') && !l.includes(' ps '));
        assert.ok(watchers().length >= 4, 'two loops and two watchers run: ' + watchers().length);
        for (const p of earlyP) process.kill(p, 'SIGKILL');
        assert.ok(await until(() => watchers().length === 0, 4000), 'the watchers stop once their loops are gone: ' + watchers().join(' | '));

        // 3. an explicit owner PID that is not running: they stop at the first check
        const dead = spawnSync('sh', ['-c', 'true'], {});
        const gone = spawnSync('sh', [SH, '1', '600', String(dead.pid || 999999)], { encoding: 'utf8' });
        const goneP = track(pidsOf(gone.stdout));
        assert.ok(await until(() => goneP.every(p => !alive(p)), 4000), 'an owner that is already gone ends the loop at once');

        // 4. bad arguments are refused, nothing started
        for (const a of [[], ['0'], ['65'], ['x'], ['2', '0'], ['2', '5', 'z']]) {
            const r = spawnSync('sh', [SH, ...a], { encoding: 'utf8' });
            assert.equal(r.status, 2, JSON.stringify(a));
            assert.equal(r.stdout, '', 'no PIDs for ' + JSON.stringify(a));
        }
        console.log('cpu_load: ok');
    } finally {
        for (const p of all) { try { process.kill(p, 'SIGKILL'); } catch { /* already gone */ } }
    }
})().catch(e => { console.error(e); process.exit(1); });
