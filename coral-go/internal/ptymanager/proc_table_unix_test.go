//go:build !windows

package ptymanager

import (
	"os"
	"os/exec"
	"sort"
	"syscall"
	"testing"
	"time"

	"github.com/shirou/gopsutil/v4/process"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// perPIDSnap is the snapshot as it was taken before #6562: gopsutil's Processes(), each process asked for its parent (a kernel call each on
// macOS), and member times from CreateTime. The new one must say the same of the same processes.
func perPIDSnap(t *testing.T) (parent map[int]int, created map[int]int64) {
	t.Helper()
	procs, err := process.Processes()
	require.NoError(t, err)
	parent, created = map[int]int{}, map[int]int64{}
	for _, p := range procs {
		pp, err := p.Ppid()
		if err != nil {
			continue
		}
		c, err := p.CreateTime()
		if err != nil {
			continue
		}
		parent[int(p.Pid)], created[int(p.Pid)] = int(pp), c
	}
	return parent, created
}

func sortedPIDs(ms []member) []int {
	var out []int
	for _, m := range ms {
		out = append(out, m.pid)
	}
	sort.Ints(out)
	return out
}

// A controlled shell and its three children stay alive through both snapshots.
// Only this tree has stable parents: unrelated processes can exit or be
// reparented between two live-machine looks (#8520).
func TestProcTableMatchesPerPIDSnapshot(t *testing.T) {
	cmd := exec.Command("sh", "-c", `
        sleep 600 & first=$!
        sleep 600 & second=$!
        sleep 600 & third=$!
        trap 'kill "$first" "$second" "$third" 2>/dev/null; wait; exit 0' TERM
        wait
    `)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} // a terminal has a group of its own; the tree never includes Coral's
	require.NoError(t, cmd.Start())
	t.Cleanup(func() {
		// Let the shell end and reap its children before it exits; killing only
		// the shell leaves three sleepers reparented on the test machine.
		_ = cmd.Process.Signal(syscall.SIGTERM)
		assert.NoError(t, cmd.Wait(), "fixture shell must reap its children")
	})

	var snap *procSnap
	require.Eventually(t, func() bool { // the children exist once the shell has forked them
		snap = takeSnap()
		n := 0
		for _, pp := range snap.parent {
			if pp == cmd.Process.Pid {
				n++
			}
		}
		return n >= 3
	}, 10*time.Second, 20*time.Millisecond)
	oldParent, oldCreated := perPIDSnap(t)

	compared := 0
	for pid, c := range oldCreated {
		if pid != cmd.Process.Pid && snap.parent[pid] != cmd.Process.Pid {
			continue // no assertion about the rest of a changing machine
		}
		nc, ok := snap.started[pid]
		require.True(t, ok, "fixture pid %d must exist in both snapshots", pid)
		compared++
		wantParent := cmd.Process.Pid
		if pid == cmd.Process.Pid {
			wantParent = os.Getpid()
		}
		assert.Equal(t, c, nc, "start time of fixture pid %d", pid)
		assert.Equal(t, wantParent, oldParent[pid], "per-pid parent of fixture pid %d", pid)
		assert.Equal(t, wantParent, snap.parent[pid], "table parent of fixture pid %d", pid)
	}
	require.Equal(t, 4, compared, "the shell and ALL three controlled children must be compared")

	created, ok := oldCreated[cmd.Process.Pid]
	require.True(t, ok)
	root := member{cmd.Process.Pid, created}
	assert.True(t, snap.has(root))
	assert.False(t, snap.has(member{root.pid, created + 1}), "a pid whose start time differs is another process")
	assert.False(t, snap.has(member{0x7ffffff0, created}), "a pid that is not there")

	got := snap.tree(root, "")
	assert.Len(t, got, 4, "exactly the controlled shell and its three children")
	for _, m := range got {
		t.Logf("fixture_member=%d started_ms=%d", m.pid, m.created)
		assert.Equal(t, oldCreated[m.pid], m.created, "member %d carries the start time the per-pid way gave it", m.pid)
	}
	assert.Contains(t, sortedPIDs(got), root.pid)
	assert.NotContains(t, sortedPIDs(got), os.Getpid())
}

// What the sampler forgets by the snapshot is what it forgot by asking each process: a member that ended is dropped, a live one kept.
func TestPruneBySnapshotMatchesPruneByAsking(t *testing.T) {
	live := exec.Command("sleep", "60")
	require.NoError(t, live.Start())
	t.Cleanup(func() { _ = live.Process.Kill(); _ = live.Wait() })
	dead := exec.Command("sleep", "60")
	require.NoError(t, dead.Start())
	_, created := perPIDSnap(t)
	liveM, deadM := member{live.Process.Pid, created[live.Process.Pid]}, member{dead.Process.Pid, created[dead.Process.Pid]}
	require.NotZero(t, liveM.created)
	require.NotZero(t, deadM.created)
	require.NoError(t, dead.Process.Kill())
	_ = dead.Wait()

	for name, prune := range map[string]func(*seen){
		"asking":   func(s *seen) { s.prune() },
		"snapshot": func(s *seen) { s.pruneBy(takeSnap().has) },
	} {
		set := &seen{}
		set.add([]member{liveM, deadM})
		prune(set)
		assert.Equal(t, []member{liveM}, set.all(), name)
	}
}
