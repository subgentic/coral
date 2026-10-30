package shellkill

import (
	"testing"

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
