//go:build !windows

package procguard

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #15011: Coral never signals itself, its parent shell, a group that holds either, or everything.
func fake(t *testing.T, self, selfG, parent, parentG int) {
	t.Helper()
	op, og, pp, pg := selfPid, selfPgid, parentPid, parentPgid
	selfPid, selfPgid = func() int { return self }, func() int { return selfG }
	parentPid, parentPgid = func() int { return parent }, func() int { return parentG }
	t.Cleanup(func() { selfPid, selfPgid, parentPid, parentPgid = op, og, pp, pg })
}

func TestRefuseNamesCoralItsParentTheirGroupsAndEverything(t *testing.T) {
	fake(t, 500, 480, 400, 390)
	for target, want := range map[int]bool{
		500: true, -480: true, 400: true, -390: true, // Coral's pid and group, the shell's pid and group
		0: true, -1: true, 1: true, // the caller's own group, every process, init
		501: false, -481: false, 399: false, -391: false, // others are the caller's to signal
	} {
		why, refused := Refuse(target)
		assert.Equal(t, want, refused, "target %d: %s", target, why)
		if refused {
			assert.NotEmpty(t, why)
		}
	}
}

// A recorded pgid that has gone stale and now equals Coral's own: the kill is refused and nothing is sent. The group here is a real child's, made Coral's own through the seam, so a refusal is the only thing
// that keeps it alive and the test never signals the test's own group.
func TestAFakedRecordedGroupEqualToCoralsOwnIsRefusedAndNothingIsSignalled(t *testing.T) {
	cmd := exec.Command("sleep", "60")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	require.NoError(t, cmd.Start())
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	t.Cleanup(func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); <-done })
	pgid := cmd.Process.Pid

	fake(t, os.Getpid(), pgid, os.Getppid(), 1) // Coral's own group is, as far as the guard knows, the child's
	err := Kill(-pgid, syscall.SIGKILL)
	require.Error(t, err)
	assert.True(t, errors.Is(err, ErrSelf), "%v", err)
	select {
	case <-done:
		t.Fatal("the signal was sent: the child ended")
	case <-time.After(300 * time.Millisecond):
	}

	selfPgid = func() int { return syscall.Getpgrp() } // Coral's real group again: the child's group is only a group
	require.NoError(t, Kill(-pgid, syscall.SIGKILL))
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("a group that is not Coral's was not signalled")
	}
}

// Security's INFO 6: when the group is refused (it is Coral's own, as a child with no group of its own sits in it), the child itself is still signalled, and a pid that is Coral's own is refused as well.
func TestARefusedGroupStillSignalsTheChildItself(t *testing.T) {
	cmd := exec.Command("sleep", "60")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	require.NoError(t, cmd.Start())
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	t.Cleanup(func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); <-done })
	pid := cmd.Process.Pid

	fake(t, os.Getpid(), pid, os.Getppid(), 1) // the child's group is, as far as the guard knows, Coral's own
	require.NoError(t, KillGroupOrPid(pid, pid, syscall.SIGKILL))
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the group was refused and the child was left running")
	}

	// Refused for the group and for the pid (the pid is Coral's own): an error the caller can see, nothing sent.
	err := KillGroupOrPid(pid, os.Getpid(), syscall.SIGUSR2)
	assert.True(t, errors.Is(err, ErrSelf), "%v", err)
}
