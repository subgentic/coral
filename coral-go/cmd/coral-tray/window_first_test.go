package main

import (
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/windowmark"
)

// A fresh install's first start that would stay in the background (macOS's login item) opens the window once; --no-browser (the updater's relaunch, or a person's choice) never does.
// The record it looks at is the tray's own file in the data folder: no analytics, no tracking milestones and no server are involved, so it is the same with analytics off.
func TestAFreshInstallsLoginItemStartOpensTheWindowOnce(t *testing.T) {
	assert.True(t, opensWindowAtStart(false, true, false), "login item, the window never shown: open it once")
	assert.False(t, opensWindowAtStart(false, true, true), "login item, shown before: background")
	assert.False(t, opensWindowAtStart(true, true, false), "--no-browser stays quiet even on a fresh install")
	assert.False(t, opensWindowAtStart(true, false, false), "--no-browser alone is the person's choice")
	assert.True(t, opensWindowAtStart(false, false, false), "a start somebody asked for opens it, as before")
	assert.True(t, opensWindowAtStart(false, false, true))
}

type noticeLog struct {
	mu   sync.Mutex
	list []string
}

func (n *noticeLog) add(s string) { n.mu.Lock(); n.list = append(n.list, s); n.mu.Unlock() }
func (n *noticeLog) all() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]string(nil), n.list...)
}

func TestAStartThatEndsWithNoWindowSaysSoInOneShortSentence(t *testing.T) {
	log.SetOutput(&strings.Builder{})
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	// the window cannot open (no coral-app, no browser): the person is told how to open Coral
	var n noticeLog
	startWindowAtLaunch(false, false, false, func() bool { return true }, func() bool { return false }, n.add)
	require.Eventually(t, func() bool { return len(n.all()) == 1 }, 2*time.Second, 10*time.Millisecond)
	assert.Equal(t, []string{noticeWindowNotOpened}, n.all())
	for _, s := range []string{noticeWindowNotOpened, noticeTermsDeclined} {
		assert.NotContains(t, s, "http", "no link in a notification")
		assert.NotContains(t, s, "token", "no token in a notification")
		assert.Less(t, len(s), 90, "one short sentence or two")
	}

	// the window opens: nothing is said
	var quiet noticeLog
	opened := make(chan struct{}, 1)
	startWindowAtLaunch(false, false, false, func() bool { return true }, func() bool { opened <- struct{}{}; return true }, quiet.add)
	<-opened
	time.Sleep(100 * time.Millisecond)
	assert.Empty(t, quiet.all())

	// a start nobody asked for says nothing and does not even look at the server
	var bg noticeLog
	startWindowAtLaunch(true, false, false, func() bool { t.Error("asked the server"); return true }, func() bool { t.Error("opened"); return true }, bg.add)
	time.Sleep(100 * time.Millisecond)
	assert.Empty(t, bg.all())

	// a server that is not running: the failed state raised its own notification (trayStatus.set), so this adds none
	var down noticeLog
	startWindowAtLaunch(false, false, false, func() bool { return false }, func() bool { t.Error("opened"); return true }, down.add)
	assert.Empty(t, down.all())
}

// A window that shows the Terms and has them declined ends with its own exit code, and trackWindow hands that code back so the tray can say so.
func TestTrackWindowReturnsTheExitCodeOfTheWindow(t *testing.T) {
	dir := t.TempDir()
	run := func(code string) int {
		cmd := exec.Command(os.Args[0], "-test.run=TestExitCodeHelper")
		cmd.Env = append(os.Environ(), "CORAL_TRAY_HELPER_EXIT="+code)
		require.NoError(t, cmd.Start())
		return trackWindow(dir, cmd, func() bool { return true })
	}
	assert.Equal(t, windowmark.AppExitTermsDeclined, run("3"), "the Terms were declined")
	assert.Equal(t, 0, run("0"), "the person closed the window")
	assert.Equal(t, 1, run("1"), "a failure")
}

func TestExitCodeHelper(t *testing.T) {
	code := os.Getenv("CORAL_TRAY_HELPER_EXIT")
	if code == "" {
		t.Skip("helper process")
	}
	switch code {
	case "3":
		os.Exit(3)
	case "1":
		os.Exit(1)
	}
	os.Exit(0)
}
