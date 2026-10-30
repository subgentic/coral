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
