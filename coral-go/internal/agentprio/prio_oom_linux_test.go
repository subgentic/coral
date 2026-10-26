//go:build linux

package agentprio

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func oomAdjOf(t *testing.T, pid int) int {
	t.Helper()
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/oom_score_adj")
	require.NoError(t, err)
	n, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	require.NoError(t, err)
	return n
}

// #8734: an agent is first for the kernel's out-of-memory killer, not Coral. Under a memory limit the killer took Coral (the larger process, both at 0) and every terminal with it.
func TestApplyMakesTheAgentTheOOMKillersFirstChoice(t *testing.T) {
	reset(t)
	self := oomAdjOf(t, os.Getpid())
	pid := startSleep(t, exec.Command("sleep", "30"))
	Apply(pid)
	assert.Equal(t, max(self, OOMAdj), oomAdjOf(t, pid), "the agent is at +500 (or where its parent already was)")
	assert.Equal(t, self, oomAdjOf(t, os.Getpid()), "the server keeps its own")

	// what the agent starts later inherits it
	sh := exec.Command("sh", "-c", "sleep 30 & wait")
	sh.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	shPid := startSleep(t, sh)
	t.Cleanup(func() { _ = syscall.Kill(-shPid, syscall.SIGKILL) })
	Apply(shPid)
	require.Eventually(t, func() bool { return len(descendants(shPid)) >= 2 }, 5*time.Second, 50*time.Millisecond)
	for _, p := range descendants(shPid) {
		assert.Equal(t, max(self, OOMAdj), oomAdjOf(t, p.pid), "pid %d", p.pid)
	}
}

func TestApplyLeavesTheOOMScoreAloneWhenAgentsRunNormalOrAreAlreadyHigher(t *testing.T) {
	reset(t)
	self := oomAdjOf(t, os.Getpid())
	SetSetting(Normal)
	normal := startSleep(t, exec.Command("sleep", "30"))
	Apply(normal)
	assert.Equal(t, self, oomAdjOf(t, normal), "normal leaves agents as the server is")

	SetSetting(Low)
	high := startSleep(t, exec.Command("sleep", "30"))
	require.NoError(t, os.WriteFile("/proc/"+strconv.Itoa(high)+"/oom_score_adj", []byte("800"), 0))
	Apply(high)
	assert.Equal(t, 800, oomAdjOf(t, high), "never lowered")
}

func TestApplyTreeMakesAnOlderPanesProcessesOOMFirstToo(t *testing.T) {
	reset(t)
	self := oomAdjOf(t, os.Getpid())
	pane := exec.Command("sh", "-c", "sleep 30 & sleep 30; wait")
	pane.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	ppid := startSleep(t, pane)
	t.Cleanup(func() { _ = syscall.Kill(-ppid, syscall.SIGKILL) })
	require.Eventually(t, func() bool { return len(descendants(ppid)) >= 3 }, 5*time.Second, 50*time.Millisecond)
	ApplyTree(ppid)
	for _, p := range descendants(ppid) {
		assert.Equal(t, max(self, OOMAdj), oomAdjOf(t, p.pid), "pid %d under the pane", p.pid)
	}
}
