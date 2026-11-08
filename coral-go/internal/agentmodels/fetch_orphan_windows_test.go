//go:build windows

package agentmodels

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/consoletest"
)

// A model fetch of a CLI that is a .cmd shim (claude.cmd runs its program as a child of cmd.exe) leaves nothing running when it ends: not when the CLI answered, and not when the
// fetch timed out. The stand-in's child is a ping of an unusual count (so only this test's own process matches), which would otherwise run for hours.

// standInChildren is the process ids of the long-lived children this test started: a ping whose command line holds "-n <count> ".
func standInChildren(t *testing.T, count int) []int {
	t.Helper()
	script := `Get-CimInstance Win32_Process -Filter "Name='PING.EXE'" | Where-Object { $_.CommandLine -like '*-n ` + strconv.Itoa(count) + ` *' } | ForEach-Object { $_.ProcessId }`
	out, err := consoletest.HiddenCommand("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script).Output()
	require.NoError(t, err)
	var ids []int
	for _, f := range strings.Fields(string(out)) {
		if id, err := strconv.Atoi(f); err == nil {
			ids = append(ids, id)
		}
	}
	return ids
}

// endStandIns ends what a test's stand-in left running, by process id, whatever the test found.
func endStandIns(t *testing.T, count int) {
	t.Helper()
	for _, id := range standInChildren(t, count) {
		_ = consoletest.HiddenCommand("taskkill.exe", "/F", "/T", "/PID", strconv.Itoa(id)).Run()
	}
}

// standIn writes a claude.cmd whose program is a ping of the given count: the stand-in's long-lived child. With answer it first reads the initialize request and prints a model list,
// as Claude Code does.
func standIn(t *testing.T, count int, answer bool) string {
	t.Helper()
	body := "@echo off\r\n"
	if answer {
		// The child is running before the answer is printed, so the fetch cannot return before it exists.
		body += "start \"\" /b ping -n " + strconv.Itoa(count) + " 127.0.0.1 >nul\r\n" +
			"set /p request=\r\n" +
			`echo {"type":"control_response","response":{"subtype":"success","response":{"models":[{"value":"opus","displayName":"Opus"}]}}}` + "\r\n"
	}
	body += "ping -n " + strconv.Itoa(count) + " 127.0.0.1 >nul\r\n"
	p := filepath.Join(t.TempDir(), "claude.cmd")
	require.NoError(t, os.WriteFile(p, []byte(body), 0o600))
	return p
}

func noChildrenLeft(t *testing.T, count int, what string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var left []int
	for time.Now().Before(deadline) {
		if left = standInChildren(t, count); len(left) == 0 {
			return
		}
		time.Sleep(250 * time.Millisecond)
	}
	assert.Empty(t, left, what)
}

// The CLI answered the model list: the fetch ends the shim, and what the shim started with it.
func TestAModelFetchThatGotItsAnswerLeavesNoChildOfTheShim(t *testing.T) {
	const count = 9731
	t.Cleanup(func() { endStandIns(t, count) })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	models, err := fetchClaude(ctx, standIn(t, count, true), t.TempDir())
	require.NoError(t, err)
	require.Len(t, models, 1, "the stand-in's answer was read")
	noChildrenLeft(t, count, "the shim's child outlived the fetch")
}

// The fetch ran out of time before the CLI answered: it ends the shim and its child with the deadline.
func TestAModelFetchThatTimedOutLeavesNoChildOfTheShim(t *testing.T) {
	const count = 9733
	t.Cleanup(func() { endStandIns(t, count) })
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	_, err := fetchClaude(ctx, standIn(t, count, false), t.TempDir())
	require.Error(t, err, "the stand-in never answers")
	noChildrenLeft(t, count, "the shim's child outlived the timed out fetch")
}
