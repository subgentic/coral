package ptymanager

import (
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/tmux"
)

// fakeProcs is a process table: who is whose child and what each process is.
type fakeProcs struct {
	mu    sync.Mutex
	kids  map[int][]int
	procs map[int]winProc
	lines map[int]string
}

func newFake() *fakeProcs {
	return &fakeProcs{kids: map[int][]int{}, procs: map[int]winProc{}, lines: map[int]string{}}
}

func (f *fakeProcs) add(parent, pid int, start int64, kind procKind) *fakeProcs {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.kids[parent] = append(f.kids[parent], pid)
	f.procs[pid] = winProc{pid: pid, start: start, kind: kind, known: true}
	return f
}

func (f *fakeProcs) remove(pid int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.procs, pid)
	for p, ks := range f.kids {
		var out []int
		for _, k := range ks {
			if k != pid {
				out = append(out, k)
			}
		}
		f.kids[p] = out
	}
}

func (f *fakeProcs) children(pid int) []int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]int(nil), f.kids[pid]...)
}

func (f *fakeProcs) info(pid int) winProc {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.procs[pid]
}

// commandLine is the command line set for pid with withLine; a process without one cannot be read.
func (f *fakeProcs) commandLine(pid int) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	line, ok := f.lines[pid]
	return line, ok && len(line) <= launcherCmdMaxLine
}

func (f *fakeProcs) withLine(pid int, line string) *fakeProcs {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lines[pid] = line
	return f
}

const root = 100 // the terminal's root: a verified PowerShell

func pane() *fakeProcs {
	f := newFake()
	f.procs[root] = winProc{pid: root, start: 10, kind: kindVerifiedShell, known: true}
	return f
}

func TestProgramsBelowWalksThroughVerifiedShellsAndLeavesOutConsoleHosts(t *testing.T) {
	// powershell -> cmd (the claude.cmd shim) -> node, with a console host beside node.
	f := pane().add(root, 200, 20, kindVerifiedShell).add(200, 300, 30, kindProgram).add(200, 301, 31, kindConsoleHost)
	progs, unknown, deep := programsBelow(f, root)
	if assert.Len(t, progs, 1, "the node behind the shim; the cmd and the console host are not programs") {
		assert.Equal(t, 300, progs[0].pid)
	}
	assert.Empty(t, unknown)
	assert.False(t, deep)
}

func TestProgramsBelowLeavesWhatRunsUnderAShellOfUnknownContents(t *testing.T) {
	f := pane().add(root, 200, 20, kindUnknownShell).add(200, 300, 30, kindProgram)
	progs, unknown, _ := programsBelow(f, root)
	assert.Empty(t, progs, "a program under git-bash is that shell's")
	assert.NotEmpty(t, unknown)
}

func TestProgramsBelowSkipsAPidReusedFromAnEarlierOwner(t *testing.T) {
	f := pane().add(root, 200, 5, kindProgram) // created before the root: an earlier owner's pid
	progs, _, _ := programsBelow(f, root)
	assert.Empty(t, progs)
}

func TestProgramsBelowIsBounded(t *testing.T) {
	f := pane()
	parent := root
	for i := 1; i <= maxWinWalkDepth+2; i++ {
		f.add(parent, 200+i, int64(20+i), kindVerifiedShell)
		parent = 200 + i
	}
	_, _, deep := programsBelow(f, root)
	assert.True(t, deep)
}

func TestAdoptSingleIsOnlyASingleProgram(t *testing.T) {
	_, ok := adoptSingle(pane(), root)
	assert.False(t, ok, "none: nothing is adopted")
	_, ok = adoptSingle(pane().add(root, 200, 20, kindProgram).add(root, 201, 21, kindProgram), root)
	assert.False(t, ok, "two candidates: nothing is adopted")
	_, ok = adoptSingle(pane().add(root, 200, 20, kindUnknownShell).add(200, 300, 30, kindProgram), root)
	assert.False(t, ok, "under a shell of unknown contents: nothing is adopted")
	_, ok = adoptSingle(pane().add(root, 200, 20, kindProgram).add(root, 201, 21, kindUnknownShell), root)
	assert.False(t, ok, "one program beside a shell of unknown contents: the pane stays unknown, nothing is adopted")
	p, ok := adoptSingle(pane().add(root, 200, 20, kindVerifiedShell).add(200, 300, 30, kindProgram), root)
	assert.True(t, ok, "node behind claude.cmd")
	assert.Equal(t, 300, p.pid)
	assert.Equal(t, int64(30), p.start)
}

// One case per condition of the typing rule; dropping the condition from decideWinNotice fails the one named for it.
func TestDecideWinNoticeOneCasePerCondition(t *testing.T) {
	agent := winProc{pid: 300, start: 30}
	for _, tc := range []struct {
		name   string
		f      *fakeProcs
		reason string // "" = allowed
	}{
		{"the agent is the only program: allowed", pane().add(root, 300, 30, kindProgram), ""},
		{"node behind claude.cmd is the agent route: allowed", pane().add(root, 200, 20, kindVerifiedShell).add(200, 300, 30, kindProgram), ""},
		{"condition: alive (the process is gone)", pane(), tmux.ReasonGone},
		{"condition: same creation time (a recycled pid)", pane().add(root, 300, 99, kindProgram), tmux.ReasonGone},
		{"condition: the only program (ping in a nested cmd beside the agent)", pane().add(root, 300, 30, kindProgram).add(root, 400, 40, kindVerifiedShell).add(400, 401, 41, kindProgram), tmux.ReasonForeground},
		{"condition: the only program (a hand-started CLI)", pane().add(root, 300, 30, kindProgram).add(root, 400, 40, kindProgram), tmux.ReasonForeground},
		{"condition: not under a shell of unknown contents", pane().add(root, 300, 30, kindProgram).add(root, 400, 40, kindUnknownShell), tmux.ReasonForeground},
		{"condition: not behind a tree too deep to walk", deepPane(), tmux.ReasonForeground},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := decideWinNotice(tc.f, root, agent)
			assert.Equal(t, tc.reason == "", v.OK)
			assert.Equal(t, tc.reason, v.Reason)
		})
	}
	// A recorded process the system could not read (not "known") is not alive for the check, even when its creation time reads the same.
	unreadable := pane().add(root, 300, 30, kindProgram)
	unreadable.procs[300] = winProc{pid: 300, start: 30, known: false}
	assert.Equal(t, tmux.ReasonGone, decideWinNotice(unreadable, root, agent).Reason)
	// A recorded process that is alive but not among the programs below the root: not in the terminal.
	f := pane()
	f.procs[300] = winProc{pid: 300, start: 30, known: true} // alive, but not a child of the terminal
	assert.Equal(t, tmux.ReasonBackground, decideWinNotice(f, root, agent).Reason)
}

func deepPane() *fakeProcs {
	f := pane().add(root, 300, 30, kindProgram)
	parent := root
	for i := 1; i <= maxWinWalkDepth+2; i++ {
		f.add(parent, 500+i, int64(20+i), kindVerifiedShell)
		parent = 500 + i
	}
	return f
}

func TestWinAgentVerdictFollowsTheRecord(t *testing.T) {
	var a winAgent
	f := pane().add(root, 300, 30, kindProgram)
	v := a.verdict(f, root)
	assert.Equal(t, tmux.ReasonNotRecorded, v.Reason, "nothing recorded: not typed")
	assert.False(t, v.OK)

	a.reset()
	defer a.stopWatch()
	v = a.verdict(f, root)
	assert.True(t, v.Wait, "the launch is moments old: wait")
	assert.Equal(t, tmux.ReasonAdopting, v.Reason)

	a.mu.Lock()
	a.proc, a.adopted, a.adopting = winProc{pid: 300, start: 30}, true, false
	a.mu.Unlock()
	assert.True(t, a.verdict(f, root).OK)
	f.remove(300)
	assert.Equal(t, tmux.ReasonGone, a.verdict(f, root).Reason)
}

// The watch records the one program that appears and stays; two candidates, or none, adopt nothing; a newer launch ends an older watch.
func TestWatchAdopts(t *testing.T) {
	tm := adoptTiming{window: 600 * time.Millisecond, every: 10 * time.Millisecond, stable: 60 * time.Millisecond}

	run := func(f *fakeProcs) (winProc, bool, *winAgent) {
		a := &winAgent{}
		gen, ctx := a.reset()
		defer a.stopWatch()
		var got winProc
		var ok bool
		a.watch(ctx, gen, tm, func() (procSource, int, bool) { return f, root, true }, func(p winProc, g bool) { got, ok = p, g })
		return got, ok, a
	}
	p, ok, a := run(pane().add(root, 300, 30, kindProgram))
	assert.True(t, ok)
	assert.Equal(t, 300, p.pid)
	rec, adopted, adopting := a.snapshot()
	assert.True(t, adopted)
	assert.False(t, adopting)
	assert.Equal(t, 300, rec.pid)

	_, ok, a = run(pane().add(root, 300, 30, kindProgram).add(root, 301, 31, kindProgram))
	assert.False(t, ok, "two candidates adopt nothing")
	_, adopted, adopting = a.snapshot()
	assert.False(t, adopted)
	assert.False(t, adopting, "the watch is over: nothing recorded, notices stay off")

	_, ok, _ = run(pane())
	assert.False(t, ok, "none adopts nothing")

	// A short-lived program (the launch script's own clear) does not stay long enough.
	f := pane().add(root, 300, 30, kindProgram)
	go func() { time.Sleep(30 * time.Millisecond); f.remove(300) }()
	_, ok, _ = run(f)
	assert.False(t, ok, "a program that does not stay winAdoptStable is not adopted")

	// A newer launch supersedes the watch of an older one.
	b := &winAgent{}
	old, oldCtx := b.reset()
	_, newCtx := b.reset()
	defer b.stopWatch()
	assert.Error(t, oldCtx.Err(), "the older watch was cancelled by the newer launch")
	assert.NoError(t, newCtx.Err())
	f2 := pane().add(root, 300, 30, kindProgram)
	called := false
	b.watch(oldCtx, old, tm, func() (procSource, int, bool) { return f2, root, true }, func(winProc, bool) { called = true })
	assert.False(t, called, "an older watch ends without recording")
	_, adopted, _ = b.snapshot()
	assert.False(t, adopted)
}

// "Record as agent" (#391) on Windows: the single program in the terminal, recorded only when it is still exactly what the Operator was shown.
func TestCandidateWinIsTheSingleProgramOrTheReasonThereIsNone(t *testing.T) {
	_, why := candidateWin(pane(), root)
	assert.Contains(t, why, "no program")
	_, why = candidateWin(pane().add(root, 300, 30, kindProgram).add(root, 301, 31, kindProgram), root)
	assert.Contains(t, why, "several programs")
	_, why = candidateWin(pane().add(root, 200, 20, kindUnknownShell).add(200, 300, 30, kindProgram), root)
	assert.Contains(t, why, "unknown contents")
	c, why := candidateWin(pane().add(root, 200, 20, kindVerifiedShell).add(200, 300, 30, kindProgram), root)
	assert.Empty(t, why)
	assert.Equal(t, 300, c.pid, "node behind claude.cmd")
}

func TestRecordWinRecordsOnlyWhatWasShown(t *testing.T) {
	f := pane().addNamed(root, 300, 30, kindProgram, "codex")
	var a winAgent
	defer a.stopWatch()

	_, err := a.recordWin(f, root, winProc{pid: 301, start: 30}, "")
	assert.ErrorIs(t, err, ErrCandidateChanged, "another pid than the one shown")
	_, err = a.recordWin(f, root, winProc{pid: 300, start: 99}, "")
	assert.ErrorIs(t, err, ErrCandidateChanged, "a recycled pid: another creation time")
	_, err = a.recordWin(f, root, winProc{}, "")
	assert.ErrorIs(t, err, ErrCandidateChanged, "nothing shown")
	_, adopted, _ := a.snapshot()
	assert.False(t, adopted, "none of the refused requests recorded anything")

	two := pane().add(root, 300, 30, kindProgram).add(root, 301, 31, kindProgram)
	_, err = a.recordWin(two, root, winProc{pid: 300, start: 30}, "")
	assert.ErrorIs(t, err, ErrNoCandidate, "two programs: nothing is guessed")
	unknown := pane().add(root, 300, 30, kindProgram).add(root, 400, 40, kindUnknownShell)
	_, err = a.recordWin(unknown, root, winProc{pid: 300, start: 30}, "")
	assert.ErrorIs(t, err, ErrNoCandidate, "a shell of unknown contents in the terminal: nothing is recorded")

	got, err := a.recordWin(f, root, winProc{pid: 300, start: 30}, "")
	assert.NoError(t, err)
	assert.Equal(t, 300, got.pid)
	assert.True(t, a.verdict(f, root).OK, "notices go now")
}

// via / Under (#391): the first shell on the way to the program; "" for a direct child of the terminal's root. Node behind claude.cmd runs under cmd, so it needs the acknowledgement.
func (f *fakeProcs) addNamed(parent, pid int, start int64, kind procKind, name string) *fakeProcs {
	f.add(parent, pid, start, kind)
	f.mu.Lock()
	defer f.mu.Unlock()
	p := f.procs[pid]
	p.name = name
	f.procs[pid] = p
	return f
}

func TestCandidateWinNamesTheShellOnTheWay(t *testing.T) {
	direct, why := candidateWin(pane().addNamed(root, 300, 30, kindProgram, "claude"), root)
	assert.Empty(t, why)
	assert.Empty(t, direct.via, "a direct child of the terminal's root")

	shim, why := candidateWin(pane().addNamed(root, 200, 20, kindVerifiedShell, "cmd").addNamed(200, 300, 30, kindProgram, "node"), root)
	assert.Empty(t, why)
	assert.Equal(t, "cmd", shim.via, "node behind claude.cmd runs under cmd")

	deeper, _ := candidateWin(pane().addNamed(root, 200, 20, kindVerifiedShell, "cmd").addNamed(200, 201, 21, kindVerifiedShell, "powershell").addNamed(201, 300, 30, kindProgram, "ping"), root)
	assert.Equal(t, "cmd", deeper.via, "the first shell on the way")

	c := winCandidateFields(shim)
	assert.Equal(t, "cmd", c.Under)
}
