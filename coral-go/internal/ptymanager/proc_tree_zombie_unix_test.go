//go:build !windows

package ptymanager

import (
	"os/exec"
	"testing"
	"time"

	"github.com/shirou/gopsutil/v4/process"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A process that has ended but whose parent has not collected it answers kill(pid, 0) like a live one (#14881): the kill of a terminal then waited for it through the whole grace. It is not alive.
func TestAnEndedProcessNobodyHasCollectedIsNotAlive(t *testing.T) {
	cmd := exec.Command("sh", "-c", "exit 0")
	require.NoError(t, cmd.Start())
	collected := false
	defer func() {
		if !collected {
			_ = cmd.Wait()
		}
	}()
	p, err := process.NewProcess(int32(cmd.Process.Pid))
	require.NoError(t, err)
	created, err := p.CreateTime()
	require.NoError(t, err)
	m := member{pid: cmd.Process.Pid, created: created}
	// not waited for: when it has ended it stays a zombie
	deadline := time.Now().Add(5 * time.Second)
	for !m.zombie() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	require.True(t, m.zombie(), "the child ended and nobody collected it")
	assert.False(t, anyAlive([]member{m}), "a zombie has already ended")
	require.NoError(t, cmd.Wait())
	collected = true
	assert.False(t, anyAlive([]member{m}), "and once collected it is gone")
}

func TestARunningProcessIsStillAlive(t *testing.T) {
	cmd := exec.Command("sleep", "30")
	require.NoError(t, cmd.Start())
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	p, err := process.NewProcess(int32(cmd.Process.Pid))
	require.NoError(t, err)
	created, err := p.CreateTime()
	require.NoError(t, err)
	m := member{pid: cmd.Process.Pid, created: created}
	assert.False(t, m.zombie())
	assert.True(t, anyAlive([]member{m}))
}
