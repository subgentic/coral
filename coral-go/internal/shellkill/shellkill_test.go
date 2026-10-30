package shellkill

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// #11157: one pkill -f "go test ./..." ended three agents whose launch prompts quote it. What stops processes by a name or a pattern is refused; a kill of a pid is not.
func TestCommandsThatStopByPatternAreRefused(t *testing.T) {
	for _, c := range []string{
		`pkill -f "go test ./..."`,
		`pkill -f fullrun.sh; pkill -f "go test ./..." ; sleep 2; git fetch`,
		`pkill claude`,
		`pkill -9 -f 'remote-debugging-port=9333'`,
		`killall node`,
		`sudo killall -9 Chrome`,
		`cd /tmp && pkill -f x`,
		`true || pkill go`,
		`(pkill -f x)`,
		`echo start; /usr/bin/pkill -f x`,
		`nohup pkill -f x`,
		`timeout 5 pkill -f x`,
		`FOO=1 pkill -f x`,
		`pgrep -f "go test" | xargs kill`,
		`pgrep -f x | xargs kill -9`,
		`ps aux | grep foo | awk '{print $2}' | xargs kill`,
		`kill $(pgrep -f x)`,
		"kill `pgrep -f x`",
		`kill -9 $(pidof node)`,
		`kill "$(ps -axo pid,command | grep x | awk '{print $1}')"`,
		"x=$(pkill -f y)",
		"echo \"$(pkill -f y)\"",
	} {
		assert.NotEmpty(t, PatternKill(c), c)
	}
}

func TestCommandsThatStopWhatWasStartedAreAllowed(t *testing.T) {
	for _, c := range []string{
		`kill 1234`,
		`kill -9 1234`,
		`kill %1`,
		`kill $pid`,
		`kill "$pid"`,
		`kill -TERM "$!"`,
		`sleep 100 & pid=$!; kill $pid`,
		`timeout 600 go test ./...`,
		`go test ./... 2>&1 | tail -3`,
		`git commit -m "Never pkill -f by a pattern"`,
		`grep -rn pkill internal`,
		`echo pkill and killall are refused`,
		`coral-board post "do not use pkill -f"`,
		"cat <<'EOF'\npkill -f x\nEOF",
		"cat > notes.md <<EOF\nkillall node\nEOF\nls",
		"cat <<-'EOF'\n\tpkill -f x\n\tEOF\necho done",
		`# pkill -f x is not run`,
		`man pkill`,
		`which pkill`,
		`pgrep -f x`,
		`ps aux | grep x`,
		`kill $(cat /tmp/pidfile)`,
		`kill "$(cat pid)"`,
		`tmux kill-session -t mine`,
		`./pkillish.sh`,
		`echo 'a;pkill b'`,
		`ls; echo done`,
		``,
	} {
		assert.Empty(t, PatternKill(c), c)
	}
}

func TestTheRefusalSaysWhatToDoInstead(t *testing.T) {
	m := Message(PatternKill(`pkill -f x`))
	assert.Contains(t, m, "pkill")
	assert.Contains(t, m, "pid=$!")
	assert.Contains(t, m, "kill %1")
	assert.Contains(t, m, "refuse_pattern_kill")
}

// Security's #11157 MUST: reading the command is bounded. It ran on every PreToolUse post of every agent, before anything was checked, and it was exponential in how deep substitutions nested: 18
// nested "$(" cost 34 s of CPU and 20 never returned. Past a bound the command is let run.
func TestReadingTheCommandIsBounded(t *testing.T) {
	inputs := map[string]string{
		"18 open substitutions":      strings.Repeat("$(", 18),
		"40 open substitutions":      strings.Repeat("$(", 40),
		"well-formed depth 16":       strings.Repeat("$(", 16) + "pkill -f x" + strings.Repeat(")", 16),
		"well-formed depth 30":       strings.Repeat("echo $(", 30) + "date" + strings.Repeat(")", 30),
		"backquotes":                 strings.Repeat("`", 5000),
		"nested double quotes":       strings.Repeat(`"$(`, 20) + "x" + strings.Repeat(`)"`, 20),
		"bash -c inside bash -c":     strings.Repeat(`bash -c "`, 12) + "pkill -f x" + strings.Repeat(`"`, 12),
		"a long run of words":        strings.Repeat("word ", 20000),
		"3000 commands":              strings.Repeat("echo a; ", 3000),
		"a megabyte of substitution": "echo " + strings.Repeat("$(echo $(echo a))", 60000),
	}
	for name, in := range inputs {
		start := time.Now()
		got := PatternKill(in)
		took := time.Since(start)
		assert.Less(t, took, 250*time.Millisecond, name)
		assert.Empty(t, got, name+": past a bound it runs")
	}
	// Inside the bounds the same shapes are read: depth 8 is, depth 9 is not.
	assert.NotEmpty(t, PatternKill(strings.Repeat("$(", 7)+"pkill -f x"+strings.Repeat(")", 7)))
	assert.Empty(t, PatternKill(strings.Repeat("$(", 9)+"pkill -f x"+strings.Repeat(")", 9)), "deeper than the bound: let run")
}

// Security's SHOULDs on #11157: a keyword starts a command, and one level of bash -c and eval is read.
func TestKeywordsAndShellScriptsAreCommandPosition(t *testing.T) {
	for _, c := range []string{
		"if true; then pkill -f x; fi",
		"for p in a b; do killall node; done",
		"while true; do pkill x; done",
		"if false; then echo; else pkill -f y; fi",
		`bash -c "pkill -f x"`,
		`sh -c 'killall node'`,
		`zsh -lc "pkill claude"`,
		`eval "pkill -f x"`,
		`eval pkill -f x`,
		`sudo bash -c "pkill -f x"`,
		`bash -c "echo hi; pkill -f x"`,
	} {
		assert.NotEmpty(t, PatternKill(c), c)
	}
	for _, c := range []string{
		`bash -c "echo pkill"`,
		`bash script.sh`,
		`sh -c 'kill 123'`,
		`eval "echo hi"`,
		`if true; then echo pkill; fi`,
		`bash -c 'git commit -m "no pkill -f"'`,
	} {
		assert.Empty(t, PatternKill(c), c)
	}
}

// QA's #11179: sudo -u X, env -u X, timeout -s SIG N and ionice -c N are wrappers whose next word is still in command position: the value of their option is not the program.
func TestWrappersWithOptionValuesStillRunTheNextWord(t *testing.T) {
	for _, c := range []string{
		`sudo -u root pkill -f x`,
		`sudo --user root killall node`,
		`sudo -E -u me pkill claude`,
		`sudo -u root -g wheel pkill x`,
		`env -u FOO pkill -f x`,
		`env -u A -u B pkill x`,
		`env --unset NAME killall node`,
		`env -i FOO=1 pkill x`,
		`timeout -s KILL 10 pkill -f x`,
		`timeout --signal=KILL 5 pkill x`,
		`timeout --signal KILL 5 pkill x`,
		`timeout -k 5 -s TERM 10 killall node`,
		`ionice -c 3 pkill x`,
		`ionice -c 2 -n 7 pkill -f y`,
		`nice -n 10 pkill x`,
		`nohup nice -n 5 sudo -u root pkill -f x`,
		`doas -u root pkill x`,
		`FOO=1 sudo -u root timeout -s KILL 5 pkill x`,
	} {
		assert.NotEmpty(t, PatternKill(c), c)
	}
	for _, c := range []string{
		`sudo -u root ls`,
		`sudo -u root kill 123`,
		`env -u FOO echo pkill`,
		`timeout -s KILL 10 go test ./...`,
		`timeout 10 sleep 3`,
		`ionice -c 3 kill 123`,
		`nice -n 10 make`,
		`sudo -u pkill ls`,
		`env -u pkill echo hi`,
		`timeout -s KILL 10 echo 'pkill -f x'`,
	} {
		assert.Empty(t, PatternKill(c), c)
	}
}

// QA's #11204 round 2 SHOULD: sh, dash and zsh after a wrapper are read like bash, so the script of "sudo sh -c", "nohup sh -c" and "env -u A sh -c" is a command in its turn.
func TestShellScriptsAfterAWrapperAreReadLikeBash(t *testing.T) {
	for _, c := range []string{
		`sudo sh -c "pkill -f x"`,
		`nohup sh -c 'killall node'`,
		`env -u A sh -c "pkill x"`,
		`sudo -u root dash -c "pkill -f x"`,
		`timeout 5 zsh -lc "pkill claude"`,
		`nice -n 5 sh -c "echo hi; pkill x"`,
		`sudo env -u A bash -c "pkill x"`,
		`FOO=1 nohup sudo -u root sh -c 'pkill -f y'`,
		`sudo sh -c "sudo sh -c 'pkill x'"`,
		`env -i /bin/sh -c "killall x"`,
		`sudo /usr/bin/zsh -c "pkill x"`,
	} {
		assert.NotEmpty(t, PatternKill(c), c)
	}
	for _, c := range []string{
		`sudo sh -c "echo pkill"`,
		`nohup sh -c 'kill 123'`,
		`env -u A sh script.sh`,
		`sudo sh -c "git commit -m 'no pkill -f'"`,
	} {
		assert.Empty(t, PatternKill(c), c)
	}
}

// QA's and Security's #11204 follow-ups: a duration may be written .5 or 5. or 5.s, and a cluster of short options ending in an option that takes a value ("sudo -nu root", "sudo -Eu root") takes the next
// word; a value attached in the cluster ("-uroot") takes none.
func TestDurationsAndOptionClustersOfWrappers(t *testing.T) {
	for _, d := range []string{"10", "1.5", ".5", "5.", "5.s", "30s", "5m", "2h", "1d", "0.5m"} {
		assert.True(t, isNumber(d), d)
	}
	for _, d := range []string{"", ".", "s", "sh", "mh", "5x", "1.2.3", "--5", "ms"} {
		assert.False(t, isNumber(d), d)
	}
	for _, c := range []string{
		`timeout .5 pkill -f x`,
		`timeout 5. pkill x`,
		`timeout 5.s killall node`,
		`sudo -nu root pkill -f x`,
		`sudo -Eu root killall node`,
		`sudo -nEu me pkill x`,
		`sudo -uroot pkill x`,
		`sudo -nuroot pkill x`,
		`env -iu A pkill x`,
		`sudo -Eu root sh -c "pkill x"`,
		`sudo -n pkill x`,
	} {
		assert.NotEmpty(t, PatternKill(c), c)
	}
	for _, c := range []string{
		`sudo -nu root ls`,
		`sudo -Eu root kill 123`,
		`sudo -uroot ls`,
		`sudo -nu pkill ls`,
		`timeout .5 sleep 1`,
	} {
		assert.Empty(t, PatternKill(c), c)
	}
}

// Security's #11157 INFOs: kill -1 and kill 0 signal every process the user can reach, or the whole process group (Coral's own panes and the other agents'); a negative number is a process group.
func TestKillOfEverythingOrAGroupIsRefused(t *testing.T) {
	for _, c := range []string{
		`kill -1`,
		`kill -9 -1`,
		`kill -KILL -1`,
		`kill -SIGKILL -1`,
		`kill -s KILL -1`,
		`kill -n 9 -1`,
		`kill 0`,
		`kill -9 0`,
		`kill -TERM 0`,
		`kill -- -1`,
		`kill -- -1234`,
		`kill -9 -- -1234`,
		`kill -9 -1234`,
		`kill -- -$pgid`,
		`kill -9 -$pgid`,
		`sudo kill -9 -1`,
		`sudo -u root kill 0`,
		`timeout 5 kill -9 -1`,
		`bash -c "kill -9 -1"`,
		`kill 1234 -1`,
		`kill 1234 0`,
	} {
		assert.NotEmpty(t, PatternKill(c), c)
	}
	for _, c := range []string{
		`kill 1234`,
		`kill -9 1234`,
		`kill -KILL 1234`,
		`kill -s TERM 1234`,
		`kill %1`,
		`kill -9 %1`,
		`kill "$pid"`,
		`kill -9 "$pid"`,
		`kill $!`,
		`kill -TERM "$!"`,
		`kill -1 1234`,
		`kill -l`,
		`kill -0 1234`,
		`kill -- 1234`,
		`kill 10 20`,
		`kill 100`,
		`echo kill -1`,
		`git commit -m "kill -9 -1"`,
	} {
		assert.Empty(t, PatternKill(c), c)
	}
}

// Security's #11157 INFO 2: the 20 ms bound on the reading, alone. A command that is inside the size, depth and command bounds but takes longer than the time to read is let run, whatever it says; the same
// command is read and refused with the time the bound normally is.
func TestTheTimeBoundAloneLetsALongReadingRun(t *testing.T) {
	command := strings.Repeat("echo a; ", 400) + "pkill -f x" // 3 KB, 400 commands, depth 0: inside every other bound
	assert.NotEmpty(t, PatternKill(command), "inside every bound it is read and refused")

	was := maxWork
	t.Cleanup(func() { maxWork = was })
	maxWork = time.Nanosecond // the time the reading may take is over at the first look at the clock
	assert.Empty(t, PatternKill(command), "past the time bound the command runs")
	maxWork = was
	assert.NotEmpty(t, PatternKill(command), "and the bound is the only thing that changed")
}
