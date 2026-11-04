#!/usr/bin/env python3
"""ci: a small test-job queue for this Mac and the Mac mini (goal #221, task #13402).

    ci submit --machine mac|mini --priority release|operator|perf|review|normal --task <id> [--timeout S] [--cwd DIR] -- <command...>
    ci run    --machine mac|mini [--once] [--poll S]       take the best pending job when the machine is free, run it, post the result
    ci status [--json]                                     running and queued jobs
    ci cancel <job id>                                     drop a pending job (your own)

A job is a JSON file in CI_HOME/<machine>/pending (default CI_HOME=~/ci-queue). `ci run` takes the highest priority, then the oldest job, only while it holds the machine's lock and
the machine is idle (no other suite runner, go test or headless Chrome younger than 4 h), runs it with a time limit in its own process group, keeps the log, and posts a result line
and the log (as an artifact) to the job's task through coral-board / coral-agent. One heavy job at a time per machine; the mini's lock is its own mini-lock (~/coral-test/bin).
Standard library only. Nothing here starts a server: a job's own command does, and the environment it gets is scrubbed (no CORAL_* from the submitter, an isolated CORAL_DATA_DIR and
TMPDIR, telemetry off). A command that names ~/.coral, port 8420, pkill, killall, sudo, an app or a launcher is refused at submit time.
"""
import argparse, base64, json, os, re, shlex, shutil, signal, subprocess, sys, time

PRIORITIES = ['release', 'operator', 'perf', 'review', 'normal']  # highest first
MACHINES = ['mac', 'mini']
DEFAULT_TIMEOUT, MAX_TIMEOUT = 1800, 7200
STALE_PROC_SECONDS = 4 * 3600
HOME = os.path.expanduser('~')
FORBIDDEN = [(r'\.coral\b', 'the real Coral folder (~/.coral)'), (r'\b8420\b', 'port 8420 (the real Coral)'), (r'\bpkill\b', 'pkill'), (r'\bkillall\b', 'killall'),
             (r'\bsudo\b', 'sudo'), (r'\bopen\s+-', 'open (it starts an app)'), (r'\bcoral-(tray|app)\b', 'the tray or the app'), (r'\blaunchctl\b', 'launchctl'),
             (r'(^|[\s;&|/])coral(\s+open)\b', 'coral open')]


def ci_home():
    return os.environ.get('CI_HOME') or os.path.join(HOME, 'ci-queue')


def mdir(machine, sub):
    d = os.path.join(ci_home(), machine, sub)
    os.makedirs(d, exist_ok=True)
    return d


def now_ms():
    return int(time.time() * 1000)


def slug(s):
    return re.sub(r'[^a-z0-9]+', '-', (s or 'agent').lower()).strip('-') or 'agent'


def read_job(path):
    with open(path) as f:
        return json.load(f)


def rd(path, **kw):
    with open(path, **kw) as f:
        return f.read()


def write_json(path, obj):
    tmp = path + '.tmp%d' % os.getpid()
    with open(tmp, 'w') as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, path)


JOB_ID_RE = re.compile(r'^\d{13}-[0-9a-f]{4}$')
OWNER_RE = re.compile(r'^[a-z0-9-]{1,40}$')
CLOSED_URL = 'http://127.0.0.1:1'  # a job's CORAL_URL: nothing answers there, so a scratch coral-board / coral-agent in a job cannot post to the live board


def lint(cmd):
    for pat, what in FORBIDDEN:
        if re.search(pat, cmd):
            return 'refused: the command names ' + what + '; a queued job never touches the real Coral, starts an app or kills processes by name'
    return ''


def validate_job(job):
    """Everything a job file must satisfy, checked again when it runs (the file may have been written by hand or changed since submit); returns a reason or ''."""
    if not isinstance(job, dict):
        return 'not a job'
    if not isinstance(job.get('id'), str) or not JOB_ID_RE.match(job['id']):
        return 'bad job id'
    if job.get('machine') not in MACHINES or job.get('priority') not in PRIORITIES:
        return 'bad machine or priority'
    if not isinstance(job.get('owner'), str) or not OWNER_RE.match(job['owner']):
        return 'bad owner name (only a-z, 0-9 and - are allowed)'
    t = job.get('task')
    if not isinstance(t, int) or isinstance(t, bool) or t < 1:
        return 'bad task number'
    to = job.get('timeout')
    if not isinstance(to, int) or isinstance(to, bool) or not 1 <= to <= MAX_TIMEOUT:
        return 'bad timeout (1 to %d seconds)' % MAX_TIMEOUT
    if not isinstance(job.get('cmd'), str) or not job['cmd'].strip() or not isinstance(job.get('cwd'), str):
        return 'bad command or folder'
    why = lint(job['cmd'])
    if why:
        return why
    if re.search(r'\.coral(/|$)', job['cwd']) or re.search(r'\.coral(/|$)', os.path.realpath(os.path.expanduser(job['cwd']))):
        return 'refused: the working folder is under ~/.coral'
    return ''


# ---- submit / status / cancel -------------------------------------------------------------------------------------------------------------------------------------------------

def cmd_submit(a):
    if not a.command:
        sys.exit('usage: ci submit --machine mac|mini --priority P --task N -- <command>')
    cmd = shlex.join(a.command) if len(a.command) > 1 else a.command[0]
    why = lint(cmd)
    if why:
        sys.exit(why)
    if not str(a.task).isdigit():
        sys.exit('--task must be a task number (the result is posted there)')
    if not 1 <= a.timeout <= MAX_TIMEOUT:
        sys.exit('--timeout must be 1 to %d seconds' % MAX_TIMEOUT)
    owner = slug(os.environ.get('CI_OWNER') or os.environ.get('CORAL_SUBSCRIBER_ID') or os.environ.get('USER') or 'agent')[:40].strip('-') or 'agent'
    cwd = a.cwd or (os.getcwd() if a.machine == 'mac' else '~/coral-test/' + slug(owner))
    if re.search(r'\.coral(/|$)', cwd):
        sys.exit('refused: the working folder is under ~/.coral')
    jid = '%013d-%s' % (now_ms(), os.urandom(2).hex())
    job = {'id': jid, 'machine': a.machine, 'priority': a.priority, 'task': int(a.task), 'owner': owner, 'cmd': cmd, 'cwd': cwd, 'timeout': a.timeout,
           'submitted_ms': int(jid.split('-')[0]), 'submitted_at': time.strftime('%Y-%m-%dT%H:%M:%S%z')}
    write_json(os.path.join(mdir(a.machine, 'pending'), jid + '.json'), job)
    print(jid)


def order_key(job):
    return (PRIORITIES.index(job['priority']), job['submitted_ms'], job['id'])


def jobs_in(machine, sub):
    d = mdir(machine, sub)
    out = []
    for fn in os.listdir(d):
        if fn.endswith('.json'):
            try:
                j = read_job(os.path.join(d, fn))
            except (OSError, ValueError):
                continue
            if isinstance(j, dict) and j.get('id') == fn[:-5] and JOB_ID_RE.match(fn[:-5]) and j.get('priority') in PRIORITIES and isinstance(j.get('submitted_ms'), int):
                out.append(j)  # (a file that is not a well-formed job is set aside by run_one, never ordered or used as a path)
    return sorted(out, key=order_key) if sub == 'pending' else sorted(out, key=lambda j: j['id'])


def cmd_status(a):
    data = {m: {'running': jobs_in(m, 'running'), 'pending': jobs_in(m, 'pending')} for m in MACHINES}
    if a.json:
        print(json.dumps(data, indent=1))
        return
    for m in MACHINES:
        r, p = data[m]['running'], data[m]['pending']
        print('%s: %s, %d queued' % (m, ('running ' + ', '.join(j['id'] for j in r)) if r else 'idle', len(p)))
        for j in r:
            print('  RUNNING %s  %-8s task #%s  %s  %s' % (j['id'], j['priority'], j['task'], j['owner'], j['cmd'][:90]))
        for j in p:
            print('  queued  %s  %-8s task #%s  %s  %s' % (j['id'], j['priority'], j['task'], j['owner'], j['cmd'][:90]))


def cmd_cancel(a):
    if not JOB_ID_RE.match(a.id):
        sys.exit('bad job id: %r (a job id looks like 1700000000000-ab12)' % a.id)
    for m in MACHINES:
        p = os.path.join(mdir(m, 'pending'), a.id + '.json')
        if os.path.exists(p):
            j = read_job(p)
            me = slug(os.environ.get('CI_OWNER') or os.environ.get('CORAL_SUBSCRIBER_ID') or os.environ.get('USER'))[:40].strip('-')
            if j['owner'] != me and not a.force:
                sys.exit('job %s belongs to %s (use --force to cancel another agent\'s job)' % (a.id, j['owner']))
            j.update(status='cancelled', ended_ms=now_ms())
            write_json(os.path.join(mdir(m, 'done'), a.id + '.json'), j)
            os.remove(p)
            print('cancelled', a.id)
            return
    sys.exit('no pending job ' + a.id)


# ---- executing one job (runs here for mac, on the mini through ssh for mini) ----------------------------------------------------------------------------------------------------

def job_env(job, tmp):
    env = {k: v for k, v in os.environ.items() if not k.startswith(('CORAL_', 'CLAUDE', 'ANTHROPIC')) and k not in ('TMUX', 'SSH_AUTH_SOCK')}
    if job['machine'] == 'mini':
        env['PATH'] = '%s/.local/bin:%s/.local/node/bin:/usr/local/go/bin:%s' % (HOME, HOME, env.get('PATH', '/usr/bin:/bin:/usr/sbin:/sbin'))  # ~/.local/bin: tmux
        env['GOCACHE'] = HOME + '/coral-test/.cache/go-build'
        env['GOMODCACHE'] = HOME + '/coral-test/.cache/go-mod'
    else:
        env['PATH'] = '%s/.local/go/bin:%s/.local/node/bin:%s' % (HOME, HOME, env.get('PATH', '/usr/bin:/bin:/usr/sbin:/sbin'))
    env.update(TMPDIR=tmp, CORAL_DATA_DIR=os.path.join(tmp, 'data'), CORAL_TELEMETRY_DISABLED='1', CI_JOB_ID=job['id'], CI_JOB_TASK=str(job['task']), CORAL_URL=CLOSED_URL)
    return env


def tmp_for(job):
    base = '/private/tmp/coral-test-' + slug(job['owner']) if job['machine'] == 'mini' else '/private/tmp/ci-' + slug(job['owner'])
    return os.path.join(base, job['id'])


def pgid_file(job_id):
    d = os.path.join(ci_home(), 'pgids')
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, job_id)


def kill_group(pgid, first=signal.SIGTERM, wait=5.0):
    """TERM, then KILL, the process group `pgid` (a group this tool made for one job)."""
    for sig in (first, signal.SIGKILL):
        try:
            os.killpg(pgid, sig)
        except (ProcessLookupError, PermissionError):
            return
        end = time.time() + (wait if sig != signal.SIGKILL else 0)
        while time.time() < end:
            try:
                os.killpg(pgid, 0)
            except (ProcessLookupError, PermissionError):
                return
            time.sleep(0.1)


def safe_rmtree(tmp, base):
    """Remove the job's temp folder only when its real path is inside the real path of its owner's base folder under /private/tmp."""
    rb, rt = os.path.realpath(base), os.path.realpath(tmp)
    if rb.startswith('/private/tmp/') and rt.startswith(rb + '/') and os.path.isdir(rt) and not os.path.islink(tmp):
        shutil.rmtree(rt, ignore_errors=True)


def exec_job(job, out):
    """Run job['cmd'] in its own process group with the time limit, copying its output to `out` (a file object); returns the result dict. Whatever stops this process (a signal, Ctrl-C)
    stops the job's group first."""
    why = validate_job(job)
    if why:
        out.write('ci: refused to run: %s\n' % why)
        out.flush()
        return {'exit': 126, 'timed_out': False, 'seconds': 0.0, 'refused': why}
    tmp = tmp_for(job)
    os.makedirs(os.path.join(tmp, 'data'), exist_ok=True)
    cwd = os.path.expanduser(job['cwd'])
    start = time.time()
    res = {'timed_out': False}
    try:
        p = subprocess.Popen(['/bin/bash', '-c', job['cmd']], cwd=cwd, env=job_env(job, tmp), stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
    except OSError as e:
        out.write('ci: could not start: %s\n' % e)
        out.flush()
        return {'exit': 127, 'timed_out': False, 'seconds': 0.0}
    pf = pgid_file(job['id'])
    with open(pf, 'w') as f:
        f.write('%d\n' % p.pid)
    old = {}
    def stop(signum, _frame):
        raise SystemExit(128 + signum)
    for sg in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        try:
            old[sg] = signal.signal(sg, stop)
        except ValueError:  # not the main thread
            pass
    try:
        try:
            res['exit'] = p.wait(timeout=job['timeout'])
        except subprocess.TimeoutExpired:
            res['timed_out'] = True
            kill_group(p.pid, wait=10)
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
            res['exit'] = 124
            out.write('\nci: time limit of %ds reached; the job\'s process group was stopped\n' % job['timeout'])
    finally:
        kill_group(p.pid, wait=3)  # a stop of this runner, or nothing of the job left behind in its group
        for sg, h in old.items():
            signal.signal(sg, h)
        try:
            os.remove(pf)
        except OSError:
            pass
        out.flush()
        safe_rmtree(tmp, os.path.dirname(tmp))
    res['seconds'] = round(time.time() - start, 1)
    return res


def cmd_install(a):
    """Copy this tool to CI_HOME/bin (default ~/ci-queue/bin) with a `ci` wrapper there: a stable path for every agent, not a checkout that may be stale."""
    d = os.path.join(ci_home(), 'bin')
    os.makedirs(d, exist_ok=True)
    shutil.copyfile(os.path.abspath(__file__), os.path.join(d, 'ci.py'))
    w = os.path.join(d, 'ci')
    with open(w, 'w') as f:
        f.write('#!/bin/sh\nexec python3 "$(dirname "$0")/ci.py" "$@"\n')
    os.chmod(w, 0o755)
    print('installed: %s (use %s submit ...)' % (d, w))


def cmd_stop(a):  # hidden: `python3 - _stop <job id>` on the mini: stop a job whose runner is gone (its ssh dropped)
    if not JOB_ID_RE.match(a.job):
        sys.exit('bad job id')
    try:
        pgid = int(rd(pgid_file(a.job)).strip())
    except (OSError, ValueError):
        return
    if pgid > 1:
        kill_group(pgid, wait=3)


def cmd_exec(a):  # hidden: `python3 - _exec <b64 job>` on the mini, the program text on stdin; prints the job's output, then a result line
    job = json.loads(base64.b64decode(a.job))
    sys.stdout.flush()
    res = exec_job(job, sys.stdout)
    print('\n@@CI_RESULT ' + json.dumps(res), flush=True)


# ---- machines: lock, idle ---------------------------------------------------------------------------------------------------------------------------------------------------------

def ssh_cmd():
    return shlex.split(os.environ.get('CI_SSH') or 'ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 mini')


def mini_bin():
    return os.environ.get('CI_MINI_BIN') or '$HOME/coral-test/bin'


def ssh_run(remote, **kw):
    return subprocess.run(ssh_cmd() + [remote], capture_output=True, text=True, **kw)


def local_idle():
    """Is nothing else heavy running here? A suite runner, go test, a test binary or a top-level headless Chrome younger than 4 h counts as busy; older ones are stale leftovers."""
    out = subprocess.run(['ps', '-axo', 'pid=,etime=,command='], capture_output=True, text=True).stdout
    busy = []
    for line in out.splitlines():
        m = re.match(r'\s*(\d+)\s+(\S+)\s+(.*)', line)
        if not m or os.getpid() == int(m.group(1)):
            continue
        pid, et, cmd = int(m.group(1)), m.group(2), m.group(3)
        # anchored to the start of the command line: the program itself, not a shell wrapper that only mentions the words
        if re.search(r'^(\S*/)?node\s+\S*run_cdp_suites\.mjs|^(\S*/)?go\s+test\s|^\S+\.test\s+-test\.|^/(?!bin/|usr/bin/)[^\n]*?/Contents/MacOS/Google Chrome\s.*--headless', cmd):  # (the app path has a space in it)
            d, rest = (et.split('-') if '-' in et else ('0', et))
            parts = [int(x) for x in rest.split(':')]
            secs = int(d) * 86400 + sum(v * 60 ** i for i, v in enumerate(reversed(parts)))
            if secs < STALE_PROC_SECONDS:
                busy.append('pid %d %s' % (pid, cmd[:100]))
    return busy


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def lock_acquire(machine, job):
    """Take the machine's lock for `job`; returns '' when held by us, else a reason."""
    what = 'ci job %s (task #%s): %s' % (job['id'], job['task'], job['cmd'][:60])
    if machine == 'mini':
        r = ssh_run('%s/mini-lock acquire ci-runner %s' % (mini_bin(), shlex.quote(what)))
        return '' if r.returncode == 0 else ('mini lock: ' + (r.stdout + r.stderr).strip()[:160])
    lock = os.path.join(ci_home(), 'mac.lock')  # the same protocol as the mini's mini-lock: mkdir is the exclusive step, then owner/what/since (and our pid)
    os.makedirs(ci_home(), exist_ok=True)
    for _ in range(2):
        try:
            os.mkdir(lock)
        except FileExistsError:
            try:
                pid = int(rd(os.path.join(lock, 'pid')).strip())
            except (OSError, ValueError):
                return 'mac lock held (its owner has not written its pid yet, or it is a lock made by hand)'  # never guess that a lock without a pid is stale
            if pid_alive(pid):
                return 'mac lock held by %s (pid %d)' % (rd(os.path.join(lock, 'what')).strip()[:80], pid)
            shutil.rmtree(lock, ignore_errors=True)  # its runner is gone: a stale lock
            continue
        try:
            for n, v in (('owner', 'ci-runner'), ('what', what), ('since', str(int(time.time()))), ('pid', str(os.getpid()))):
                with open(os.path.join(lock, n), 'w') as f:
                    f.write(v + '\n')
        except OSError:
            shutil.rmtree(lock, ignore_errors=True)
            raise
        return ''
    return 'mac lock busy'


def lock_release(machine):
    if machine == 'mini':
        ssh_run('%s/mini-lock release ci-runner' % mini_bin())
    else:
        shutil.rmtree(os.path.join(ci_home(), 'mac.lock'), ignore_errors=True)


def machine_idle(machine):
    if machine == 'mini':
        r = ssh_run('%s/mini-idle' % mini_bin())
        return [] if r.returncode == 0 else [(r.stdout + r.stderr).strip()[:160]]
    return local_idle()


# ---- run --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

def post_result(job, res, logpath):
    """Post the result line and the log (as an artifact) to the job's task; failures are printed and never stop the queue."""
    tail = ''.join(rd(logpath, errors='replace').splitlines(True)[-12:])
    uri = ''
    try:
        r = subprocess.run(['coral-agent', 'artifact', 'upload', logpath, '--name', 'ci-%s.log' % job['id'], '--media-type', 'text/plain', '--no-task'], capture_output=True, text=True, timeout=120)
        m = re.search(r'"uri"\s*:\s*"([^"]+)"', r.stdout)
        uri = m.group(1) if m else ''
    except (OSError, subprocess.SubprocessError):
        pass
    state = 'TIMED OUT' if res.get('timed_out') else ('PASSED' if res['exit'] == 0 else 'FAILED')
    text = 'ci job %s for %s on %s (%s): %s, exit=%s, %ss\ncommand: %s\n' % (job['id'], job['owner'], job['machine'], job['priority'], state, res['exit'], res.get('seconds'), job['cmd'][:300])
    text += ('log: ' + uri + '\n' if uri else 'log: ' + logpath + ' (not uploaded)\n') + 'last lines:\n' + tail
    text = text.replace('@', '')  # a job's text never mentions (notifies) anyone
    try:
        subprocess.run(['coral-board', 'post', '--task', str(job['task']), '-'], input=text, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as e:
        print('ci: could not post the result: %s' % e, file=sys.stderr)


def set_aside_bad_files(machine):
    """A pending file that is not a well-formed job (bad name, id that differs from its name, unreadable) is moved to done/ as refused-*; its name is never used to build a path."""
    d, dd = mdir(machine, 'pending'), mdir(machine, 'done')
    ok = {j['id'] for j in jobs_in(machine, 'pending')}
    for fn in os.listdir(d):
        if fn.endswith('.json') and fn[:-5] not in ok:
            os.replace(os.path.join(d, fn), os.path.join(dd, 'refused-%d-%s' % (now_ms(), re.sub(r'[^A-Za-z0-9.]', '_', fn))))


def refuse(machine, job, why):
    src = os.path.join(mdir(machine, 'pending'), job['id'] + '.json')
    if os.path.exists(src):
        job.update(status='refused', reason=why, ended_ms=now_ms())
        write_json(os.path.join(mdir(machine, 'done'), job['id'] + '.json'), job)
        os.remove(src)
    return 'refused job %s: %s' % (job['id'], why)


def run_one(machine, post=True):
    """Run the best pending job if the machine is free. Returns 'ran', 'empty' or a reason it did not."""
    set_aside_bad_files(machine)
    pend = jobs_in(machine, 'pending')
    if not pend:
        return 'empty'
    job = pend[0]
    why = validate_job(job)
    if why:  # re-lint at run time: a refused job never runs, and is finished as 'refused'
        return refuse(machine, job, why)
    busy = machine_idle(machine)  # BEFORE the lock: the mini's mini-idle counts a held lock (ours too) as busy
    if busy:
        return 'machine busy: ' + busy[0]
    why = lock_acquire(machine, job)
    if why:
        return why
    stopped = [True]  # becomes False once the job's result is recorded
    runp = os.path.join(mdir(machine, 'running'), job['id'] + '.json')
    old = {}
    def stop(signum, _frame):
        raise SystemExit(128 + signum)
    for sg in (signal.SIGTERM, signal.SIGHUP):
        try:
            old[sg] = signal.signal(sg, stop)
        except ValueError:
            pass
    try:
        src = os.path.join(mdir(machine, 'pending'), job['id'] + '.json')
        runp = os.path.join(mdir(machine, 'running'), job['id'] + '.json')
        try:
            os.rename(src, runp)  # a second runner that got here first took it
        except FileNotFoundError:
            return 'taken'
        job['started_ms'] = now_ms()
        write_json(runp, job)
        logpath = os.path.join(mdir(machine, 'logs'), job['id'] + '.log')
        with open(logpath, 'w') as out:
            if machine == 'mini':
                payload = base64.b64encode(json.dumps(job).encode()).decode()
                with open(os.path.abspath(__file__)) as srcf:
                    p = subprocess.Popen(ssh_cmd() + ['python3', '-', '_exec', payload], stdin=srcf, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                buf = []
                try:
                    for line in p.stdout:
                        if line.startswith('@@CI_RESULT '):
                            buf = json.loads(line[len('@@CI_RESULT '):])
                        else:
                            out.write(line)
                    p.wait()
                finally:
                    if p.poll() is None:  # this runner is being stopped: close the ssh
                        p.terminate()
                    if not buf:  # no result line (the ssh dropped, or we were stopped): the job may still run over there; stop its group
                        try:
                            ssh_run('python3 - _stop %s' % job['id'], input=rd(os.path.abspath(__file__)), timeout=60)
                        except (OSError, subprocess.SubprocessError):
                            pass
                res = buf if isinstance(buf, dict) and 'exit' in buf else {'exit': 255, 'timed_out': False, 'seconds': None}
            else:
                res = exec_job(job, out)
        job.update(res, ended_ms=now_ms(), status='done', log=logpath)
        write_json(os.path.join(mdir(machine, 'done'), job['id'] + '.json'), job)
        os.remove(runp)
        if post:
            post_result(job, res, logpath)
        stopped[0] = False
        return 'ran'
    finally:
        if stopped[0] and os.path.exists(runp):  # the runner was stopped mid-job: the job's group is already stopped; finish its record
            try:
                job.update(status='stopped', exit=143, ended_ms=now_ms())
                write_json(os.path.join(mdir(machine, 'done'), job['id'] + '.json'), job)
                os.remove(runp)
            except OSError:
                pass
        for sg, h in old.items():
            signal.signal(sg, h)
        lock_release(machine)


def cmd_run(a):
    last = None
    while True:
        r = run_one(a.machine, post=not a.no_post)
        if r != last and r != 'ran':
            print('%s: %s' % (time.strftime('%H:%M:%S'), r), flush=True)
        last = r
        done = r == 'ran' or r.startswith('refused')  # a refused job is finished: look at the next one at once
        if a.once:
            sys.exit(0 if done or r == 'empty' else 3)
        if not done:
            time.sleep(a.poll)


def main():
    ap = argparse.ArgumentParser(prog='ci', description=__doc__.split('\n')[0])
    sp = ap.add_subparsers(dest='cmd', required=True)
    s = sp.add_parser('submit')
    s.add_argument('--machine', choices=MACHINES, required=True)
    s.add_argument('--priority', choices=PRIORITIES, default='normal')
    s.add_argument('--task', required=True)
    s.add_argument('--timeout', type=int, default=DEFAULT_TIMEOUT)
    s.add_argument('--cwd')
    s.add_argument('command', nargs=argparse.REMAINDER)
    s.set_defaults(f=cmd_submit)
    r = sp.add_parser('run')
    r.add_argument('--machine', choices=MACHINES, required=True)
    r.add_argument('--once', action='store_true')
    r.add_argument('--poll', type=float, default=15)
    r.add_argument('--no-post', action='store_true')
    r.set_defaults(f=cmd_run)
    t = sp.add_parser('status')
    t.add_argument('--json', action='store_true')
    t.set_defaults(f=cmd_status)
    c = sp.add_parser('cancel')
    c.add_argument('id')
    c.add_argument('--force', action='store_true')
    c.set_defaults(f=cmd_cancel)
    i = sp.add_parser('install')
    i.set_defaults(f=cmd_install)
    e = sp.add_parser('_exec')
    e.add_argument('job')
    e.set_defaults(f=cmd_exec)
    x = sp.add_parser('_stop')
    x.add_argument('job')
    x.set_defaults(f=cmd_stop)
    args = ap.parse_args()
    if args.cmd == 'submit' and args.command and args.command[0] == '--':
        args.command = args.command[1:]
    args.f(args)


if __name__ == '__main__':
    main()
