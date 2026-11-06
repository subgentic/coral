package resources

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/pkg/resourcequeue"
)

type fakePrio map[string][2]int

func (f fakePrio) Of(_ context.Context, agent string) (int, string, int, error) {
	v := f[agent]
	return v[0], "", v[1], nil
}

func order(t *testing.T, m *Manager, key string) []string {
	t.Helper()
	st, err := m.Queue().Status(key)
	require.NoError(t, err)
	var out []string
	for _, e := range st.Queue {
		out = append(out, e.Agent)
	}
	return out
}

func TestAClaimIsRankedByTheTaskTheAgentIsWorkingOn(t *testing.T) {
	m, err := Open(Options{Priorities: fakePrio{"gate": {7, 30}, "low": {8, 0}, "mid": {9, 10}}, AgeStep: -1})
	require.NoError(t, err)
	require.NoError(t, m.Queue().Define(resourcequeue.Resource{Key: "mac", Slots: 1}))
	for _, a := range []string{"holder", "low", "mid", "gate", "no-task"} {
		_, err := m.Claim(t.Context(), "mac", a, "")
		require.NoError(t, err)
	}
	assert.Equal(t, []string{"gate", "mid", "low", "no-task"}, order(t, m, "mac"))
	st, _ := m.Queue().Status("mac")
	assert.Equal(t, 7, st.Queue[0].Task, "the task is shown so a person can see why")
}

func TestTaskRank(t *testing.T) {
	assert.Equal(t, []int{30, 20, 10, 0, 0}, []int{TaskRank("critical"), TaskRank("high"), TaskRank("medium"), TaskRank("low"), TaskRank("nonsense")})
}

func TestTheBoardRanksAnAgentByItsMostImportantTaskInProgress(t *testing.T) {
	dir := t.TempDir()
	s, err := board.NewStoreWithKey(filepath.Join(dir, "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { s.Close() })
	ctx := context.Background()
	for _, who := range []string{"Gate Agent", "Plain Agent"} {
		_, err := s.Subscribe(ctx, "alpha", who, who, "", nil, "")
		require.NoError(t, err)
	}
	g, err := s.CreateTask(ctx, "alpha", "the gate", "", "critical", "Gate Agent", "Gate Agent")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "alpha", "Gate Agent", g.ID)
	require.NoError(t, err)
	m, err := Open(Options{Priorities: BoardPriorities{Store: s}, AgeStep: -1})
	require.NoError(t, err)
	require.NoError(t, m.Queue().Define(resourcequeue.Resource{Key: "mini", Slots: 1}))
	for _, a := range []string{"holder", "Plain Agent", "Gate Agent"} {
		_, err := m.Claim(ctx, "mini", a, "")
		require.NoError(t, err)
	}
	assert.Equal(t, []string{"Gate Agent", "Plain Agent"}, order(t, m, "mini"), "the agent on a critical task goes first, with nobody having to say so")
}

func TestTheStateIsKeptInAPrivateFileAndComesBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "resources.json")
	m, err := Open(Options{Path: path})
	require.NoError(t, err)
	require.NoError(t, m.Queue().Define(resourcequeue.Resource{Key: "mac", Slots: 1}))
	_, err = m.Claim(t.Context(), "mac", "a", "")
	require.NoError(t, err)
	_, err = m.Claim(t.Context(), "mac", "b", "")
	require.NoError(t, err)
	fi, err := os.Stat(path)
	require.NoError(t, err)
	if runtime.GOOS != "windows" { // Windows has no permission bits: a file in the user's own data folder is private by its folder's access list
		assert.Equal(t, os.FileMode(0o600), fi.Mode().Perm())
	}
	again, err := Open(Options{Path: path})
	require.NoError(t, err)
	st, err := again.Queue().Status("mac")
	require.NoError(t, err)
	require.Len(t, st.Holders, 1)
	assert.Equal(t, "a", st.Holders[0].Agent, "a restart does not forget who holds the Mac")
	assert.Equal(t, []string{"b"}, order(t, again, "mac"))
}

func TestAStateFileThatCannotBeReadIsAnErrorNotAnEmptyQueue(t *testing.T) {
	path := filepath.Join(t.TempDir(), "resources.json")
	require.NoError(t, os.WriteFile(path, []byte("{not json"), 0o600))
	_, err := Open(Options{Path: path})
	assert.Error(t, err)
}

func TestTheReaperEndsLeasesAndDropsAgentsThatAreGone(t *testing.T) {
	var mu sync.Mutex
	now := time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC)
	clock := func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	alive := map[string]bool{"a": true, "b": true}
	var amu sync.Mutex
	m, err := Open(Options{Now: clock, Alive: func(a string) bool { amu.Lock(); defer amu.Unlock(); return alive[a] }})
	require.NoError(t, err)
	require.NoError(t, m.Queue().Define(resourcequeue.Resource{Key: "mac", Slots: 1, MaxLease: time.Hour}))
	_, _ = m.Claim(t.Context(), "mac", "a", "")
	_, _ = m.Claim(t.Context(), "mac", "b", "")
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	go m.Run(ctx, 5*time.Millisecond)
	amu.Lock()
	alive["a"] = false
	amu.Unlock()
	require.Eventually(t, func() bool {
		st, _ := m.Queue().Status("mac")
		return len(st.Holders) == 1 && st.Holders[0].Agent == "b"
	}, 2*time.Second, 5*time.Millisecond, "a gone holder loses the slot to the next in line")
	mu.Lock()
	now = now.Add(2 * time.Hour)
	mu.Unlock()
	require.Eventually(t, func() bool {
		st, _ := m.Queue().Status("mac")
		return len(st.Holders) == 0
	}, 2*time.Second, 5*time.Millisecond, "a lease that ran out ends")
}

// #13833: two agents of two boards can share a name. A claim from one is never ranked by, nor shows, the other board's task: the task is read from the boards the claiming SESSION is on.
func TestAClaimShowsOnlyATaskFromTheBoardTheClaimingSessionIsOn(t *testing.T) {
	s, err := board.NewStoreWithKey(filepath.Join(t.TempDir(), "board.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { s.Close() })
	ctx := context.Background()
	_, err = s.Subscribe(ctx, "go-team", "Frontend Dev", "Frontend Dev", "sess-go", nil, "")
	require.NoError(t, err)
	_, err = s.Subscribe(ctx, "hub-team", "Frontend Dev", "Frontend Dev", "sess-hub", nil, "")
	require.NoError(t, err)
	own, err := s.CreateTask(ctx, "go-team", "markdown editor", "", "medium", "Frontend Dev", "Frontend Dev")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "go-team", "Frontend Dev", own.ID)
	require.NoError(t, err)
	other, err := s.CreateTask(ctx, "hub-team", "the hub's own task", "", "critical", "Frontend Dev", "Frontend Dev")
	require.NoError(t, err)
	_, err = s.ClaimTask(ctx, "hub-team", "Frontend Dev", other.ID)
	require.NoError(t, err)
	pri := BoardPriorities{Store: s}

	task, project, rank, err := pri.Of(WithSession(ctx, "sess-go"), "Frontend Dev")
	require.NoError(t, err)
	assert.Equal(t, [3]any{int(own.ID), "go-team", TaskRank("medium")}, [3]any{task, project, rank}, "the task of the board this session is on, though the other is more important")
	task, project, _, err = pri.Of(WithSession(ctx, "sess-hub"), "Frontend Dev")
	require.NoError(t, err)
	assert.Equal(t, [2]any{int(other.ID), "hub-team"}, [2]any{task, project})
	task, project, rank, err = pri.Of(WithSession(ctx, "sess-nowhere"), "Frontend Dev")
	require.NoError(t, err)
	assert.Equal(t, [3]any{0, "", 0}, [3]any{task, project, rank}, "a session on no board: no task shown, rather than a wrong one")
}
