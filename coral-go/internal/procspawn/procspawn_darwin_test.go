//go:build darwin

package procspawn

import (
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"

	"github.com/ebitengine/purego"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func responsibleOf(t *testing.T, pid int) int {
	t.Helper()
	lib, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	require.NoError(t, err)
	var get func(pid int32) int32
	purego.RegisterLibFunc(&get, lib, "responsibility_get_pid_responsible_for_pid")
	return int(get(int32(pid)))
}

// #12836: a process Coral starts the usual way is attributed to the same responsible process as Coral (Coral.app), so macOS takes it down with that app; one started with
// Spawn is its own responsible process.
func TestASpawnedProcessIsItsOwnResponsibleProcess(t *testing.T) {
	require.True(t, Supported())
	plain := exec.Command("sleep", "30")
	require.NoError(t, plain.Start())
	defer func() { _ = plain.Process.Kill(); _, _ = plain.Process.Wait() }()
	assert.Equal(t, responsibleOf(t, os.Getpid()), responsibleOf(t, plain.Process.Pid), "the ordinary start keeps Coral's responsible process (the premise of the fix)")
	assert.NotEqual(t, plain.Process.Pid, responsibleOf(t, plain.Process.Pid))

	sleep, err := exec.LookPath("sleep")
	require.NoError(t, err)
	pid, err := Spawn(sleep, []string{"sleep", "30"}, Options{Env: os.Environ(), Setsid: true})
	require.NoError(t, err)
	p, _ := os.FindProcess(pid)
	defer func() { _ = p.Kill(); _, _ = p.Wait() }()
	assert.Equal(t, pid, responsibleOf(t, pid), "a spawned process is its own responsible process")
	assert.NotEqual(t, responsibleOf(t, os.Getpid()), responsibleOf(t, pid))
	sid, err := syscall.Getsid(pid)
	require.NoError(t, err)
	assert.Equal(t, pid, sid, "Setsid: a session of its own")
}

func TestSpawnWiresItsFilesAndEnvironmentAndReportsAMissingProgram(t *testing.T) {
	r, w, err := os.Pipe()
	require.NoError(t, err)
	defer r.Close()
	sh, _ := exec.LookPath("sh")
	pid, err := Spawn(sh, []string{"sh", "-c", "echo $PROBE; echo err >&2; cat"}, Options{Env: []string{"PROBE=hello"}, Stdout: w, Stderr: w})
	require.NoError(t, err)
	w.Close()
	p, _ := os.FindProcess(pid)
	done := make(chan *os.ProcessState, 1)
	go func() { st, _ := p.Wait(); done <- st }() // stdin is /dev/null: cat ends at once
	buf := make([]byte, 64)
	n, _ := r.Read(buf)
	assert.Contains(t, string(buf[:n]), "hello")
	select {
	case st := <-done:
		assert.True(t, st.Success())
	case <-time.After(10 * time.Second):
		t.Fatal("the process did not end")
	}
	_, err = Spawn("/nonexistent/tmux", []string{"tmux"}, Options{})
	assert.ErrorIs(t, err, syscall.ENOENT)
}
