#!/usr/bin/env python3
"""Tests of tests/ci/ci.py (task #13402): ordering, priority, the machine lock, the idle check, the time limit, the scrubbed environment, result posting, the mini path (through a fake ssh),
and one job at a time. Run: python3 -m unittest discover -s tests/ci -v   (no network, no Coral, nothing outside a temp folder; the host's own load does not matter: `ps` is a stub)."""
import json, os, shutil, subprocess, sys, tempfile, time, unittest

CI = os.environ.get('CI_PY') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ci.py')  # CI_PY: a mutated copy, to see the tests fail
SYSPATH = '/usr/bin:/bin:/usr/sbin:/sbin'


def rd(p):
    with open(p) as f:
        return f.read()


def wr(p, v=''):
    with open(p, 'w') as f:
        f.write(v)


def jl(p):
    with open(p) as f:
        return json.load(f)


class Base(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix='citest.')
        self.home, self.stubs, self.minibin = (os.path.join(self.d, x) for x in ('queue', 'stubs', 'minibin'))
        for p in (self.home, self.stubs, self.minibin):
            os.makedirs(p)
        self.log = os.path.join(self.d, 'stub.log')
        self.psfile = os.path.join(self.d, 'ps.out')
        wr(self.psfile)
        self.stub('coral-board', 'echo "coral-board $*" >> "$STUB_LOG"; cat >> "$STUB_LOG"; echo "--end--" >> "$STUB_LOG"')
        self.stub('coral-agent', 'echo "coral-agent $*" >> "$STUB_LOG"; echo \'{"uri":"coral://artifacts/abc123"}\'')
        self.stub('ps', 'cat "$STUB_PS"')
        self.stub('fake-ssh', 'if [ $# -eq 1 ]; then exec sh -c "$1"; else exec "$@"; fi')
        # the mini's helpers, as simple stand-ins: a lock directory and an idle flag
        with open(os.path.join(self.minibin, 'mini-lock'), 'w') as f:
            f.write('#!/bin/sh\nL=%s/minilock\ncase "$1" in acquire) mkdir "$L" 2>/dev/null && { echo "$*" >> %s/minilock.log; exit 0; } || exit 1;; release) rm -rf "$L"; echo "release" >> %s/minilock.log;; esac\n' % (self.d, self.d, self.d))
        with open(os.path.join(self.minibin, 'mini-idle'), 'w') as f:
            f.write('#!/bin/sh\n[ -e %s/mini-busy ] && exit 1\n[ -d %s/minilock ] && exit 1  # like the real mini-idle: a held lock, even ours, counts as busy\nexit 0\n' % (self.d, self.d))
        for n in ('mini-lock', 'mini-idle'):
            os.chmod(os.path.join(self.minibin, n), 0o755)
        self.env = {'PATH': self.stubs + ':' + SYSPATH, 'HOME': self.d, 'CI_HOME': self.home, 'STUB_LOG': self.log, 'STUB_PS': self.psfile, 'CI_OWNER': 'tester',
                    'CI_SSH': os.path.join(self.stubs, 'fake-ssh'), 'CI_MINI_BIN': self.minibin}

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def stub(self, name, body):
        p = os.path.join(self.stubs, name)
        with open(p, 'w') as f:
            f.write('#!/bin/sh\n' + body + '\n')
        os.chmod(p, 0o755)

    def ci(self, *args, env=None, **kw):
        e = dict(self.env)
        e.update(env or {})
        return subprocess.run([sys.executable, CI] + list(args), env=e, capture_output=True, text=True, **kw)

    def submit(self, machine, priority, cmd, task=7, timeout=60):
        r = self.ci('submit', '--machine', machine, '--priority', priority, '--task', str(task), '--timeout', str(timeout), '--cwd', self.d, '--', *cmd)
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        time.sleep(0.02)  # ids carry milliseconds: keep submit order visible
        return r.stdout.strip()

    def stub_log(self):
        return rd(self.log) if os.path.exists(self.log) else ''


class SubmitTests(Base):
    def test_submit_writes_a_job_file(self):
        jid = self.submit('mac', 'perf', ['echo', 'hi'])
        j = jl(os.path.join(self.home, 'mac', 'pending', jid + '.json'))
        self.assertEqual((j['machine'], j['priority'], j['task'], j['owner'], j['timeout']), ('mac', 'perf', 7, 'tester', 60))
        self.assertEqual(j['cmd'], 'echo hi')

    def test_refuses_what_a_queued_job_must_never_do(self):
        for bad in (['ls', '~/.coral'], ['curl', 'http://127.0.0.1:8420/api'], ['pkill', '-f', 'x'], ['killall', 'Chrome'], ['sudo', 'ls'], ['open', '-a', 'Coral'], ['coral-tray']):
            r = self.ci('submit', '--machine', 'mac', '--task', '7', '--', *bad)
            self.assertNotEqual(r.returncode, 0, bad)
            self.assertIn('refused', r.stderr, bad)
        self.assertEqual(os.listdir(os.path.join(self.home, 'mac', 'pending')) if os.path.isdir(os.path.join(self.home, 'mac', 'pending')) else [], [])

    def test_refuses_bad_arguments(self):
        self.assertNotEqual(self.ci('submit', '--machine', 'pc', '--task', '7', '--', 'ls').returncode, 0)
        self.assertNotEqual(self.ci('submit', '--machine', 'mac', '--priority', 'urgent', '--task', '7', '--', 'ls').returncode, 0)
        self.assertNotEqual(self.ci('submit', '--machine', 'mac', '--task', 'abc', '--', 'ls').returncode, 0)
        self.assertNotEqual(self.ci('submit', '--machine', 'mac', '--task', '7', '--timeout', '99999', '--', 'ls').returncode, 0)
        self.assertNotEqual(self.ci('submit', '--machine', 'mac', '--task', '7').returncode, 0)


class OrderTests(Base):
    def run_all(self, machine='mac', n=10):
        for _ in range(n):
            if self.ci('run', '--machine', machine, '--once', '--no-post').stdout.strip().endswith('empty'):
                break

    def test_highest_priority_first(self):
        order = os.path.join(self.d, 'order.txt')
        for pr in ('normal', 'review', 'release', 'perf', 'operator'):
            self.submit('mac', pr, ['sh', '-c', 'echo %s >> %s' % (pr, order)])
        self.run_all()
        self.assertEqual(rd(order).split(), ['release', 'operator', 'perf', 'review', 'normal'])

    def test_oldest_first_within_a_priority(self):
        order = os.path.join(self.d, 'order.txt')
        for i in range(4):
            self.submit('mac', 'perf', ['sh', '-c', 'echo %d >> %s' % (i, order)])
        self.run_all()
        self.assertEqual(rd(order).split(), ['0', '1', '2', '3'])

    def test_a_later_higher_priority_job_goes_before_the_waiting_ones(self):
        order = os.path.join(self.d, 'order.txt')
        self.submit('mac', 'normal', ['sh', '-c', 'echo first-normal >> %s' % order])
        self.submit('mac', 'normal', ['sh', '-c', 'echo second-normal >> %s' % order])
        self.submit('mac', 'release', ['sh', '-c', 'echo release >> %s' % order])
        self.run_all()
        self.assertEqual(rd(order).split(), ['release', 'first-normal', 'second-normal'])

    def test_the_two_machines_have_their_own_queues(self):
        self.submit('mac', 'normal', ['echo', 'a'])
        r = self.ci('run', '--machine', 'mini', '--once', '--no-post')
        self.assertTrue(r.stdout.strip().endswith('empty'), r.stdout)
        self.assertEqual(len(os.listdir(os.path.join(self.home, 'mac', 'pending'))), 1)


class LockTests(Base):
    def test_a_held_lock_keeps_the_job_waiting_and_a_release_lets_it_run(self):
        self.submit('mac', 'normal', ['echo', 'x'])
        lock = os.path.join(self.home, 'mac.lock')
        os.makedirs(lock)
        for n, v in (('owner', 'someone'), ('what', 'a heavy run'), ('since', str(int(time.time()))), ('pid', str(os.getpid()))):
            wr(os.path.join(lock, n), v)
        r = self.ci('run', '--machine', 'mac', '--once', '--no-post')
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertEqual(len(os.listdir(os.path.join(self.home, 'mac', 'pending'))), 1)
        shutil.rmtree(lock)
        r = self.ci('run', '--machine', 'mac', '--once', '--no-post')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(len(os.listdir(os.path.join(self.home, 'mac', 'done'))), 1)
        self.assertFalse(os.path.exists(lock), 'the lock is given back')

    def test_a_lock_whose_runner_is_gone_is_taken_over(self):
        self.submit('mac', 'normal', ['echo', 'x'])
        lock = os.path.join(self.home, 'mac.lock')
        os.makedirs(lock)
        for n, v in (('owner', 'dead'), ('what', 'old'), ('since', '1'), ('pid', '999999')):
            wr(os.path.join(lock, n), v)
        self.assertEqual(self.ci('run', '--machine', 'mac', '--once', '--no-post').returncode, 0)
        self.assertEqual(len(os.listdir(os.path.join(self.home, 'mac', 'done'))), 1)

    def test_a_lock_folder_that_is_not_complete_yet_is_never_taken(self):
        self.submit('mac', 'normal', ['echo', 'x'])
        lock = os.path.join(self.home, 'mac.lock')
        os.makedirs(lock)  # a runner is between making the folder and writing its pid
        r = self.ci('run', '--machine', 'mac', '--once', '--no-post')
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertTrue(os.path.isdir(lock), 'the other runner\'s lock folder is still there')
        self.assertEqual(len(os.listdir(os.path.join(self.home, 'mac', 'pending'))), 1)

    def test_another_heavy_process_on_the_machine_makes_the_job_wait(self):
        self.submit('mac', 'normal', ['echo', 'x'])
        wr(self.psfile, '  4242 00:05:00 node /x/tests/frontend/run_cdp_suites.mjs --only foo\n')
        r = self.ci('run', '--machine', 'mac', '--once', '--no-post')
        self.assertEqual(r.returncode, 3)
        self.assertIn('machine busy', r.stdout)
        self.assertFalse(os.path.exists(os.path.join(self.home, 'mac.lock')), 'the lock is given back')
        wr(self.psfile, '  4242 15-03:00:00 node /x/tests/frontend/run_cdp_suites.mjs --only foo\n')  # a 15-day-old leftover is not busy
        self.assertEqual(self.ci('run', '--machine', 'mac', '--once', '--no-post').returncode, 0)

    def test_a_shell_wrapper_that_only_mentions_the_words_is_not_busy(self):
        self.submit('mac', 'normal', ['echo', 'x'])
        wr(self.psfile, '  4243 00:00:05 /bin/zsh -c source /x/snapshot.sh && eval \'cd /y && go test ./... && node tests/frontend/run_cdp_suites.mjs --only foo\'\n')
        r = self.ci('run', '--machine', 'mac', '--once', '--no-post')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        for line in ('  4244 00:01:00 /usr/local/go/bin/go test -count=1 ./internal/foo\n', '  4245 00:01:00 /tmp/x/foo.test -test.v -test.run Bar\n',
                     '  4246 00:01:00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --remote-debugging-port=0 about:blank\n'):
            self.submit('mac', 'normal', ['echo', 'y'])
            wr(self.psfile, line)
            r = self.ci('run', '--machine', 'mac', '--once', '--no-post')
            self.assertEqual(r.returncode, 3, line + r.stdout)
            os.remove(os.path.join(self.home, 'mac', 'pending', os.listdir(os.path.join(self.home, 'mac', 'pending'))[0]))

    def test_two_runners_never_overlap(self):
        marks = os.path.join(self.d, 'marks.txt')
        for i in range(2):
            self.submit('mac', 'normal', ['sh', '-c', 'echo start%d $(date +%%s) >> %s; sleep 2; echo end%d $(date +%%s) >> %s' % (i, marks, i, marks)])
        procs = [subprocess.Popen([sys.executable, CI, 'run', '--machine', 'mac', '--once', '--no-post'], env=self.env, stdout=subprocess.PIPE, text=True) for _ in range(2)]
        for p in procs:
            p.wait()
        self.assertEqual(sorted(p.returncode for p in procs), [0, 3], 'one ran, the other found the machine taken')
        self.assertEqual(len(os.listdir(os.path.join(self.home, 'mac', 'pending'))), 1, 'the second job still waits')
        lines = rd(marks).split('\n')
        self.assertEqual(len([l for l in lines if l.startswith('start')]), 1)


class RunTests(Base):
    def test_the_time_limit_stops_the_jobs_whole_process_group(self):
        pidfile = os.path.join(self.d, 'child.pid')
        self.submit('mac', 'normal', ['sh', '-c', 'sleep 60 & echo $! > %s; wait' % pidfile], timeout=2)
        t0 = time.time()
        r = self.ci('run', '--machine', 'mac', '--once')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertLess(time.time() - t0, 30)
        j = jl(os.path.join(self.home, 'mac', 'done', os.listdir(os.path.join(self.home, 'mac', 'done'))[0]))
        self.assertTrue(j['timed_out'])
        self.assertEqual(j['exit'], 124)
        child = int(rd(pidfile))
        for _ in range(30):
            try:
                os.kill(child, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        else:
            self.fail('the job\'s child process is still running')
        self.assertIn('TIMED OUT', self.stub_log())

    def test_the_job_gets_a_scrubbed_isolated_environment(self):
        out = os.path.join(self.d, 'env.txt')
        self.submit('mac', 'normal', ['sh', '-c', 'env > %s' % out])
        r = self.ci('run', '--machine', 'mac', '--once', '--no-post', env={'CORAL_URL': 'http://127.0.0.1:8420', 'CORAL_PORT': '8420', 'CORAL_SESSION_TOKEN': 'secret', 'CORAL_DATA_DIR': os.path.expanduser('~/.coral'), 'TMUX': '/tmp/x,1,0'})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        env = dict(l.split('=', 1) for l in rd(out).splitlines() if '=' in l)
        for k in ('CORAL_PORT', 'CORAL_SESSION_TOKEN', 'TMUX'):
            self.assertNotIn(k, env)
        self.assertEqual(env['CORAL_URL'], 'http://127.0.0.1:1', 'a closed URL: a scratch coral-board in a job cannot reach the live board')
        self.assertTrue(env['CORAL_DATA_DIR'].startswith('/private/tmp/ci-tester/'), env['CORAL_DATA_DIR'])
        self.assertEqual(env['CORAL_TELEMETRY_DISABLED'], '1')
        self.assertTrue(env['TMPDIR'].startswith('/private/tmp/ci-tester/'))

    def test_the_result_and_the_log_are_posted_to_the_task(self):
        self.submit('mac', 'review', ['sh', '-c', 'echo line-one; echo line-two'], task=4242)
        self.assertEqual(self.ci('run', '--machine', 'mac', '--once').returncode, 0)
        log = self.stub_log()
        self.assertIn('coral-board post --task 4242 -', log)
        self.assertIn('PASSED', log)
        self.assertIn('exit=0', log)
        self.assertIn('line-two', log)
        self.assertIn('coral://artifacts/abc123', log)
        self.assertIn('tester', log)
        self.assertNotIn('@', log.split('coral-board post', 1)[1], 'a posted text never mentions anyone')

    def test_an_at_sign_in_a_jobs_output_or_command_is_dropped_from_the_post(self):
        self.submit('mac', 'normal', ['sh', '-c', 'echo "ping @Operator and @QA"'], task=9)
        self.assertEqual(self.ci('run', '--machine', 'mac', '--once').returncode, 0)
        body = self.stub_log().split('coral-board post', 1)[1]
        self.assertIn('ping Operator and QA', body)
        self.assertNotIn('@', body)

    def test_a_failing_job_is_reported_as_failed(self):
        self.submit('mac', 'normal', ['sh', '-c', 'echo bad; exit 3'])
        self.assertEqual(self.ci('run', '--machine', 'mac', '--once').returncode, 0)
        self.assertIn('FAILED', self.stub_log())
        self.assertIn('exit=3', self.stub_log())

    def test_status_and_cancel(self):
        a = self.submit('mac', 'normal', ['echo', 'a'])
        self.submit('mini', 'release', ['echo', 'b'])
        s = self.ci('status').stdout
        self.assertIn(a, s)
        self.assertIn('release', s)
        self.assertEqual(self.ci('cancel', a).returncode, 0)
        self.assertNotIn(a, self.ci('status').stdout)
        j = jl(os.path.join(self.home, 'mac', 'done', a + '.json'))
        self.assertEqual(j['status'], 'cancelled')
        other = self.submit('mac', 'normal', ['echo', 'c'])
        self.assertNotEqual(self.ci('cancel', other, env={'CI_OWNER': 'someone-else'}).returncode, 0, 'not your job')


class InstallTests(Base):
    def test_install_puts_a_working_ci_at_a_stable_path(self):
        r = self.ci('install')
        self.assertEqual(r.returncode, 0, r.stderr)
        w = os.path.join(self.home, 'bin', 'ci')
        self.assertTrue(os.access(w, os.X_OK))
        out = subprocess.run([w, 'status'], env=self.env, capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn('mac: idle', out.stdout)


class MiniTests(Base):
    def test_a_mini_job_runs_through_ssh_under_the_minis_lock(self):
        self.submit('mini', 'operator', ['sh', '-c', 'echo hello-from-the-mini; pwd'], task=99)
        r = self.ci('run', '--machine', 'mini', '--once')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        done = os.path.join(self.home, 'mini', 'done')
        j = jl(os.path.join(done, os.listdir(done)[0]))
        self.assertEqual(j['exit'], 0)
        self.assertIn('hello-from-the-mini', rd(j['log']))
        self.assertIn('acquire ci-runner', rd(os.path.join(self.d, 'minilock.log')))
        self.assertIn('release', rd(os.path.join(self.d, 'minilock.log')))
        self.assertFalse(os.path.exists(os.path.join(self.d, 'minilock')), 'the mini lock is given back')
        self.assertIn('--task 99', self.stub_log())

    def test_a_busy_mini_keeps_the_job_waiting(self):
        self.submit('mini', 'normal', ['echo', 'x'])
        wr(os.path.join(self.d, 'mini-busy'))
        r = self.ci('run', '--machine', 'mini', '--once', '--no-post')
        self.assertEqual(r.returncode, 3)
        self.assertIn('machine busy', r.stdout)
        self.assertEqual(len(os.listdir(os.path.join(self.home, 'mini', 'pending'))), 1)
        self.assertFalse(os.path.exists(os.path.join(self.d, 'minilock')))

    def test_a_held_mini_lock_keeps_the_job_waiting(self):
        self.submit('mini', 'normal', ['echo', 'x'])
        os.makedirs(os.path.join(self.d, 'minilock'))
        r = self.ci('run', '--machine', 'mini', '--once', '--no-post')
        self.assertEqual(r.returncode, 3)
        self.assertEqual(len(os.listdir(os.path.join(self.home, 'mini', 'pending'))), 1)

    def test_a_mini_jobs_path_has_local_bin_first_for_tmux(self):
        out = os.path.join(self.d, 'path.txt')
        self.submit('mini', 'normal', ['sh', '-c', 'echo $PATH > %s' % out])
        self.assertEqual(self.ci('run', '--machine', 'mini', '--once', '--no-post').returncode, 0)
        parts = rd(out).strip().split(':')
        self.assertEqual(parts[:2], [self.d + '/.local/bin', self.d + '/.local/node/bin'])

    def test_the_time_limit_applies_on_the_mini_too(self):
        self.submit('mini', 'normal', ['sleep', '60'], timeout=2)
        t0 = time.time()
        self.assertEqual(self.ci('run', '--machine', 'mini', '--once', '--no-post').returncode, 0)
        self.assertLess(time.time() - t0, 30)
        done = os.path.join(self.home, 'mini', 'done')
        j = jl(os.path.join(done, os.listdir(done)[0]))
        self.assertTrue(j['timed_out'])


class SecurityTests(Base):
    def hand_job(self, machine, jid, **over):
        j = {'id': jid, 'machine': machine, 'priority': 'normal', 'task': 5, 'owner': 'tester', 'cmd': 'echo ok', 'cwd': self.d, 'timeout': 60, 'submitted_ms': 1700000000000}
        j.update(over)
        os.makedirs(os.path.join(self.home, machine, 'pending'), exist_ok=True)
        wr(os.path.join(self.home, machine, 'pending', jid + '.json'), json.dumps(j))
        return j

    def done_files(self, machine):
        d = os.path.join(self.home, machine, 'done')
        return sorted(os.listdir(d)) if os.path.isdir(d) else []

    def test_cancel_and_run_never_use_a_job_id_that_is_not_the_exact_format(self):
        victim = os.path.join(self.d, 'victim')
        os.makedirs(victim)
        wr(os.path.join(victim, 'x.json'), json.dumps({'owner': 'tester'}))
        self.assertNotEqual(self.ci('cancel', '../../../../' + victim.lstrip('/') + '/x').returncode, 0)
        self.assertTrue(os.path.exists(os.path.join(victim, 'x.json')))
        os.makedirs(os.path.join(self.home, 'mac', 'pending'))
        j = self.hand_job('mac', '../../evil')  # a file whose id is a path
        wr(os.path.join(self.home, 'mac', 'pending', 'weird.json'), json.dumps(dict(j, id='1700000000000-abcd')))  # a name that differs from its id
        r = self.ci('run', '--machine', 'mac', '--once', '--no-post')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(os.listdir(os.path.join(self.home, 'mac', 'pending')), [], 'both files were set aside')
        self.assertTrue(all(f.startswith('refused-') for f in self.done_files('mac')), self.done_files('mac'))

    def test_an_owner_name_with_a_path_in_it_never_runs_and_never_makes_a_folder(self):
        marker = os.path.join(self.d, 'ran')
        self.hand_job('mac', '1700000000000-abcd', owner='../../../../Users/x', cmd='touch %s' % marker)
        self.assertEqual(self.ci('run', '--machine', 'mac', '--once', '--no-post').returncode, 0)
        self.assertFalse(os.path.exists(marker))
        self.assertEqual(jl(os.path.join(self.home, 'mac', 'done', '1700000000000-abcd.json'))['status'], 'refused')

    def test_a_job_file_is_linted_again_when_it_runs(self):
        marker = os.path.join(self.d, 'ran')
        for n, over in enumerate(({'cmd': 'touch %s; echo pkill' % marker}, {'cmd': 'touch %s' % marker, 'timeout': 999999}, {'cmd': 'touch %s' % marker, 'cwd': os.path.expanduser('~/.coral/x')},
                                  {'cmd': 'touch %s; echo 8420' % marker}, {'cmd': 'touch %s' % marker, 'timeout': 'forever'}, {'cmd': 'touch %s' % marker, 'task': 'x'})):
            self.hand_job('mac', '17000000000%02d-abcd' % n, **over)
        for _ in range(6):
            self.assertEqual(self.ci('run', '--machine', 'mac', '--once', '--no-post').returncode, 0)
        self.assertFalse(os.path.exists(marker), 'a refused job must not run')
        self.assertEqual([jl(os.path.join(self.home, 'mac', 'done', f))['status'] for f in self.done_files('mac')], ['refused'] * 6)

    def test_owner_names_are_reduced_to_a_z_0_9_and_dash(self):
        jid = self.submit('mac', 'normal', ['echo', 'x'])
        self.assertEqual(self.ci('submit', '--machine', 'mac', '--task', '7', '--', 'echo', 'y', env={'CI_OWNER': '../Evil Name@x'}).returncode, 0)
        owners = {jl(os.path.join(self.home, 'mac', 'pending', f))['owner'] for f in os.listdir(os.path.join(self.home, 'mac', 'pending'))}
        self.assertEqual(owners, {'tester', 'evil-name-x'})

    def _start_runner_and_stop_it(self, machine):
        pidfile = os.path.join(self.d, 'child.pid')
        self.submit(machine, 'normal', ['sh', '-c', 'sleep 60 & echo $! > %s; wait' % pidfile], timeout=120)
        e = dict(self.env)
        p = subprocess.Popen([sys.executable, CI, 'run', '--machine', machine, '--once', '--no-post'], env=e, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for _ in range(100):
            if os.path.exists(pidfile) and rd(pidfile).strip():
                break
            time.sleep(0.1)
        child = int(rd(pidfile))
        p.terminate()  # the runner is stopped (not the job's own time limit)
        p.wait(timeout=30)
        for _ in range(50):
            try:
                os.kill(child, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        else:
            os.kill(child, 9)
            self.fail('the job\'s child is still running after its runner was stopped')
        return p

    def test_stopping_the_runner_stops_the_jobs_group_and_frees_the_lock_on_the_mac(self):
        self._start_runner_and_stop_it('mac')
        self.assertFalse(os.path.exists(os.path.join(self.home, 'mac.lock')), 'the lock is released')
        self.assertEqual(os.listdir(os.path.join(self.home, 'mac', 'running')), [])
        self.assertEqual([jl(os.path.join(self.home, 'mac', 'done', f))['status'] for f in self.done_files('mac')], ['stopped'])

    def test_stopping_the_runner_stops_the_jobs_group_and_frees_the_lock_on_the_mini(self):
        self._start_runner_and_stop_it('mini')
        self.assertFalse(os.path.exists(os.path.join(self.d, 'minilock')), 'the mini lock is released')
        self.assertEqual([jl(os.path.join(self.home, 'mini', 'done', f))['status'] for f in self.done_files('mini')], ['stopped'])

    def test_the_remote_stop_kills_a_group_by_its_job_id_and_refuses_other_ids(self):
        p = subprocess.Popen(['sleep', '60'], start_new_session=True)
        os.makedirs(os.path.join(self.home, 'pgids'))
        wr(os.path.join(self.home, 'pgids', '1700000000000-abcd'), '%d\n' % p.pid)
        self.assertNotEqual(self.ci('_stop', '../x').returncode, 0)
        self.assertIsNone(p.poll())
        self.assertEqual(self.ci('_stop', '1700000000000-abcd').returncode, 0)
        p.wait(timeout=10)

    def test_a_symlink_left_where_the_temp_folder_was_never_gets_its_target_removed(self):
        outside = os.path.join(self.d, 'outside')
        os.makedirs(outside)
        wr(os.path.join(outside, 'keep.txt'), 'precious')
        self.submit('mac', 'normal', ['sh', '-c', 'rm -rf "$TMPDIR" && ln -s %s "$TMPDIR"' % outside])
        self.assertEqual(self.ci('run', '--machine', 'mac', '--once', '--no-post').returncode, 0)
        self.assertEqual(rd(os.path.join(outside, 'keep.txt')), 'precious')

    def test_a_job_a_second_runner_took_first_is_not_run_again(self):
        marker = os.path.join(self.d, 'ran')
        self.submit('mac', 'normal', ['sh', '-c', 'touch %s' % marker])
        code = ("import sys, os; sys.path.insert(0, %r); import ci\n"
                "ci.local_idle = lambda: []\n"
                "real = os.rename\n"
                "def rename(a, b):\n"
                "    os.remove(a)  # the other runner moved it first\n"
                "    raise FileNotFoundError(a)\n"
                "os.rename = rename\n"
                "print(ci.run_one('mac', post=False))\n") % os.path.dirname(CI)
        r = subprocess.run([sys.executable, '-c', code], env=dict(self.env), capture_output=True, text=True)
        self.assertEqual(r.stdout.strip(), 'taken', r.stdout + r.stderr)
        self.assertFalse(os.path.exists(marker))
        self.assertFalse(os.path.exists(os.path.join(self.home, 'mac.lock')), 'the lock is released')

    def test_the_ssh_command_notices_a_dead_connection(self):
        r = subprocess.run([sys.executable, '-c', 'import sys; sys.path.insert(0, %r); import ci; print(" ".join(ci.ssh_cmd()))' % os.path.dirname(CI)], env={'PATH': SYSPATH, 'HOME': self.d}, capture_output=True, text=True)
        self.assertIn('ServerAliveInterval=', r.stdout, r.stdout + r.stderr)
        self.assertIn('ServerAliveCountMax=', r.stdout)


if __name__ == '__main__':
    unittest.main()
