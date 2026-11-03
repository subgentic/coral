package routes

import (
	"bytes"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/sshprov"
	terms "github.com/subgentic/coral/pkg/license"
)

// A failed restart of an upgrade says why and how to do it by hand (#12947, the Operator: "failed to restart" and nothing else). The person sees a fixed sentence per failure and a block of commands under the
// failed step; the exit code and the end of the far computer's own log go to the hub's log, never to the person (#12027: text from the far side is not shown).

type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}
func (l *lockedBuf) String() string { l.mu.Lock(); defer l.mu.Unlock(); return l.b.String() }

// captureSlog sends the hub's log to a buffer for the test and puts the old one back after.
func captureSlog(t *testing.T) func() string {
	t.Helper()
	buf := &lockedBuf{}
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(old) })
	return buf.String
}

// stepHelp is the lines of help under the named step of a plan view, joined; empty when it has none.
func stepHelp(t *testing.T, view map[string]any, step string) string {
	t.Helper()
	steps, _ := view["steps"].([]any)
	for _, s := range steps {
		m, _ := s.(map[string]any)
		if m["name"] == step {
			var lines []string
			h, _ := m["help"].([]any)
			for _, l := range h {
				lines = append(lines, fmt.Sprint(l))
			}
			return strings.Join(lines, "\n")
		}
	}
	return ""
}

func (me *manageEnv) writeFarLog(t *testing.T, text string) {
	t.Helper()
	require.NoError(t, os.WriteFile(filepath.Join(me.home, ".coral-server", "coral.log"), []byte(text), 0o600))
}

// upgradeFails runs an upgrade on the fake far computer until the plan fails and returns the failed view.
func (me *manageEnv) upgradeFails(t *testing.T) map[string]any {
	t.Helper()
	_, v := me.plan(t, "upgrade", nil)
	plan := v["plan"].(string)
	me.connectAndRun(t, plan, map[string]any{"accept_terms": true, "terms_sha256": terms.EULADigest()}, 202)
	return me.waitPhase(t, plan, "failed")
}

// wantRestartHelp is what every failed restart shows: the log, the stop, the start with this hub's release (2.0.10 in the fake), and what to do after.
func wantRestartHelp(t *testing.T, help string) {
	t.Helper()
	assert.Contains(t, help, "tail -n 40 ~/.coral-server/coral.log", "how to read why it failed")
	assert.Contains(t, help, `kill "$(cat ~/.coral-server/coral.pid)"`, "how to stop what is running")
	assert.Contains(t, help, "tmux ls", "how to see what runs Coral there: a Coral of an earlier set-up has no log and no pid")
	assert.Contains(t, help, "tmux kill-session -t coral-server", "and to end that older kind")
	assert.Contains(t, help, `grep -F "$HOME/.coral-server/"`, "and a process of this install")
	assert.Contains(t, help, "~/.coral-server/2.0.10/root/coral --host 127.0.0.1 --port 8420 --no-browser --cloud-url off", "how to start it, the release this hub installed")
	assert.Contains(t, help, "--home ~/.coral-server/data")
	assert.Contains(t, help, "choose Upgrade here again", "and what to do after")
	assert.NotContains(t, help, "api_key", "no secret is in the help")
}

func TestManageUpgradeSaysWhyTheStartFailedAndHowToStartItByHand(t *testing.T) {
	logs := captureSlog(t)
	me := newManageEnv(t)
	require.NoError(t, os.WriteFile(filepath.Join(me.dir, "startexit"), []byte("9\n"), 0o600))
	me.writeFarLog(t, "starting\nthe disk is full marker\n")
	failed := me.upgradeFails(t)
	assert.Contains(t, failed["error"], "could not be started", "what failed")
	assert.Contains(t, failed["error"], "code 9", "and how")
	assert.NotEqual(t, "Could not start the new release.", failed["error"], "the old sentence said nothing")
	wantRestartHelp(t, stepHelp(t, failed, "restart"))
	assert.NotContains(t, fmt.Sprint(failed), "disk is full marker", "the far computer's own text is not shown to the person")
	l := logs()
	assert.Contains(t, l, "exit_code=9", "the hub's log has the exit code")
	assert.Contains(t, l, "disk is full marker", "and the end of the far computer's log")
}

func TestManageUpgradeSaysWhenTmuxIsGoneAndHowToStartWithoutIt(t *testing.T) {
	me := newManageEnv(t)
	require.NoError(t, os.WriteFile(filepath.Join(me.dir, "startexit"), []byte("7\n"), 0o600))
	failed := me.upgradeFails(t)
	assert.Contains(t, failed["error"], "tmux")
	assert.Contains(t, failed["error"], "not installed")
	help := stepHelp(t, failed, "restart")
	wantRestartHelp(t, help)
	assert.Contains(t, help, "rm ~/.coral-server/backend", "the way to start without tmux, said once")
}

func TestManageUpgradeThatDoesNotAnswerPointsAtTheLogAndLogsItsEnd(t *testing.T) {
	logs := captureSlog(t)
	me := newManageEnv(t) // health keeps saying the old version
	me.writeFarLog(t, "listening\nfatal: bad config marker\n")
	failed := me.upgradeFails(t)
	assert.Equal(t, "The new release was started, but it did not answer as expected.", failed["error"], "the sentence is as it was")
	help := stepHelp(t, failed, "verify")
	wantRestartHelp(t, help)
	assert.Contains(t, help, "It may still be starting, or it stopped again", "why this can be")
	assert.Contains(t, logs(), "bad config marker", "the end of the far computer's log is in the hub's log")
	assert.NotContains(t, fmt.Sprint(failed), "bad config marker")
}

func TestManageUpgradeThatCannotStopGivesTheStopByHand(t *testing.T) {
	defer sshprov.SetStopTimingForTest(200*time.Millisecond, 20*time.Millisecond)()
	me := newManageEnv(t)
	require.NoError(t, os.WriteFile(filepath.Join(me.dir, "stuck"), nil, 0o600))
	failed := me.upgradeFails(t)
	assert.Contains(t, failed["error"], "did not stop")
	assert.Contains(t, failed["error"], "seconds", "how long it was given")
	wantRestartHelp(t, stepHelp(t, failed, "restart"))
}

func TestManageUpgradeNamingPort8420AlsoGivesTheSteps(t *testing.T) {
	defer sshprov.SetStopTimingForTest(200*time.Millisecond, 20*time.Millisecond)()
	me := newManageEnv(t)
	require.NoError(t, os.WriteFile(filepath.Join(me.dir, "portheld"), nil, 0o600))
	failed := me.upgradeFails(t)
	assert.Equal(t, portInUseSentence, failed["error"], "the sentence is as it was")
	wantRestartHelp(t, stepHelp(t, failed, "restart"))
}

// What reaches the hub's log is the end of the far log, bounded and cleaned: the last lines, no control characters, a long line cut.
func TestTheFarLogEndInTheHubLogIsBoundedAndClean(t *testing.T) {
	logs := captureSlog(t)
	me := newManageEnv(t)
	var b strings.Builder
	for i := 0; i < 300; i++ {
		fmt.Fprintf(&b, "old line %03d\n", i)
	}
	b.WriteString("\x1b[31mred escape\x1b[0m and a bell \a here\n")
	b.WriteString(strings.Repeat("x", 5000) + "\n")
	b.WriteString("the last line marker\n")
	me.writeFarLog(t, b.String())
	_ = me.upgradeFails(t)
	l := logs()
	assert.Contains(t, l, "the last line marker")
	assert.NotContains(t, l, "old line 000", "only the end of the log")
	assert.NotContains(t, l, "\x1b", "no control characters")
	assert.NotContains(t, l, strings.Repeat("x", 1000), "a long line is cut")
}

// Each way the stop is not confirmed says which (what the check found), so the person is not left guessing (#12947: no log and no pid file on that computer).
func TestManageUpgradeSaysWhichWayTheStopWasNotConfirmed(t *testing.T) {
	defer sshprov.SetStopTimingForTest(200*time.Millisecond, 20*time.Millisecond)()
	for code, want := range map[string]string{
		"1": "tmux session named coral-server",
		"2": "Coral process of this user",
		"3": "could not say whether Coral had stopped",
	} {
		logs := captureSlog(t)
		me := newManageEnv(t)
		require.NoError(t, os.WriteFile(filepath.Join(me.dir, "stuck"), []byte(code+"\n"), 0o600))
		failed := me.upgradeFails(t)
		assert.Contains(t, failed["error"], want, "the check found "+code)
		assert.Contains(t, failed["error"], "new release was not started", code)
		wantRestartHelp(t, stepHelp(t, failed, "restart"))
		assert.Contains(t, logs(), "found="+code, "the hub's log has what the check found")
	}
}
