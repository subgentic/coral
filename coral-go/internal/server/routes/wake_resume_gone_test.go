package routes

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// A Claude agent whose conversation is gone (#12714): the wake looks for the transcript first and starts a new conversation under the same session id (with its start prompt: its role and board), says so once on the
// board, and treats the CLI's own "No conversation found" line as a backstop. Isolated: a temp data folder, a temp projects folder, the stub CLI, the mock terminal.

const goneSID = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f"

type goneRig struct {
	h    *SessionsHandler
	term *fgSessionTerminal
	ss   *store.SessionStore
	srv  string
	name string
	wd   string
}

func newGoneRig(t *testing.T) *goneRig {
	t.Helper()
	_, h, mock, ss := setupSessionsTestServer(t)
	term := newFGTerminal(mock)
	h.terminal = term
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h.bs = bs
	require.NoError(t, ss.SetSetting(context.Background(), "cli_path_claude", stubCLI(t)))
	r := chi.NewRouter()
	r.Post("/api/sessions/live/{sessionID}/wake", h.WakeSession)
	srv := httptestServer(t, r)
	name := naming.SessionName("claude", goneSID)
	wd := t.TempDir()
	team := "team"
	disp := "Security Reviewer"
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: goneSID, AgentType: "claude", AgentName: "repo", WorkingDir: wd, IsSleeping: 1, BoardName: &team, DisplayName: &disp}))
	_, err = bs.Subscribe(context.Background(), team, "Security Reviewer", "Security Reviewer", name, nil, "")
	require.NoError(t, err)
	t.Setenv("CLAUDE_PROJECTS_DIR", t.TempDir()) // no conversation of anyone, unless a test writes one
	return &goneRig{h: h, term: term, ss: ss, srv: srv, name: name, wd: wd}
}

func (g *goneRig) launchLines() string { return strings.Join(g.term.sentTo(g.name+".0"), "\n") }

func (g *goneRig) notes() int {
	msgs, err := g.h.bs.ListMessages(context.Background(), "team", 100, 0, 0)
	if err != nil {
		return -1
	}
	n := 0
	for _, m := range msgs {
		if strings.Contains(m.Content, "could not resume its conversation, so it started fresh") {
			n++
		}
	}
	return n
}

func (g *goneRig) wake(t *testing.T) {
	t.Helper()
	postArchiveOK(t, g.srv+"/api/sessions/live/"+goneSID+"/wake")
}

func writeTranscript(t *testing.T, dir, sid string) {
	t.Helper()
	proj := filepath.Join(dir, "-some-project")
	require.NoError(t, os.MkdirAll(proj, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(proj, sid+".jsonl"), []byte(`{"type":"user"}`+"\n"), 0o600))
}

// haveClaudeConversation gives each Claude session its transcript in a temp projects folder, so a wake of it resumes (a wake of a session with none starts fresh, #12714).
func haveClaudeConversation(t *testing.T, ids ...string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", dir)
	for _, id := range ids {
		writeTranscript(t, dir, id)
	}
}

func TestAWakeWithItsTranscriptResumesTheConversation(t *testing.T) {
	g := newGoneRig(t)
	writeTranscript(t, os.Getenv("CLAUDE_PROJECTS_DIR"), goneSID)

	g.wake(t)

	cmds := g.launchLines()
	assert.Contains(t, cmds, "--resume "+goneSID, "its conversation is resumed")
	assert.NotContains(t, cmds, "--session-id")
	assert.Equal(t, 0, g.notes(), "nothing to tell")
}

// sawConversation records token usage for the session, as the token poller does from a transcript it reads: Coral once found this conversation.
func (g *goneRig) sawConversation(t *testing.T) {
	t.Helper()
	require.NoError(t, store.NewTokenUsageStore(g.h.db).RecordUsage(context.Background(), &store.TokenUsage{SessionID: goneSID, AgentName: "repo", AgentType: "claude", InputTokens: 10, OutputTokens: 5, TotalTokens: 15, NumTurns: 1, RecordedAt: time.Now().UTC().Format(time.RFC3339Nano)}))
}

func TestAWakeWithNoTranscriptStartsFreshUnderTheSameIdAndTheBoardIsToldOnce(t *testing.T) {
	g := newGoneRig(t)   // the projects folder holds nothing
	g.sawConversation(t) // but Coral read this conversation once

	g.wake(t)

	cmds := g.launchLines()
	require.NotEmpty(t, cmds, "the agent was started, not left as a bare shell")
	assert.Contains(t, cmds, "--session-id "+goneSID, "a new conversation under the same session id")
	assert.NotContains(t, cmds, "--resume", "never a resume of what is gone")
	assert.Equal(t, 1, g.notes(), "the board is told, once: %q")
	ls, err := g.ss.GetLiveSession(context.Background(), goneSID)
	require.NoError(t, err)
	assert.EqualValues(t, 0, ls.IsSleeping, "awake, with its identity")
	assert.Equal(t, goneSID, ls.SessionID)
}

func TestTheTranscriptIsLookedForUnderTheClaudeConfigFolderToo(t *testing.T) {
	g := newGoneRig(t)
	t.Setenv("CLAUDE_PROJECTS_DIR", "")
	cfg := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", cfg)
	writeTranscript(t, filepath.Join(cfg, "projects"), goneSID)

	g.wake(t)

	assert.Contains(t, g.launchLines(), "--resume "+goneSID, "found under $CLAUDE_CONFIG_DIR/projects")
}

func TestTheCLIsOwnLineIsABackstopForATranscriptThatWentAfterTheLook(t *testing.T) {
	g := newGoneRig(t)
	writeTranscript(t, os.Getenv("CLAUDE_PROJECTS_DIR"), goneSID)
	prev := wakeResumeCheckAfter
	wakeResumeCheckAfter = 300 * time.Millisecond
	t.Cleanup(func() { wakeResumeCheckAfter = prev })

	g.wake(t)
	require.Contains(t, g.launchLines(), "--resume "+goneSID, "the first start resumed: the transcript was there when looked at")
	// Claude then read its own folder and found nothing: it printed the line and returned to the shell.
	logFile := naming.LogFile(g.h.cfg.LogDir, "claude", goneSID)
	require.NoError(t, os.MkdirAll(filepath.Dir(logFile), 0o700))
	require.NoError(t, os.WriteFile(logFile, []byte("$ claude --resume "+goneSID+"\nNo conversation found with session ID: "+goneSID+"\n$ \n"), 0o600))
	g.term.setFG(g.name, "zsh")
	// the transcript still LOOKS present to Coral: only the CLI's own line says the conversation is gone, so only the backstop can start it fresh

	require.Eventually(t, func() bool { return strings.Contains(g.launchLines(), "--session-id "+goneSID) }, 5*time.Second, 50*time.Millisecond,
		"the line was seen and the agent started fresh in the same terminal: %q", g.launchLines())
	assert.Eventually(t, func() bool { return g.notes() == 1 }, 3*time.Second, 50*time.Millisecond, "and the board is told once")
}

// Security's SHOULD 3 on #12714: when the backstop's wake does not launch (the CLI is still alive in its terminal), the "conversation is gone" note is not left for a later wake to start fresh on.
func TestTheBackstopLeavesNoFlagWhenItsWakeDidNotLaunch(t *testing.T) {
	g := newGoneRig(t)
	writeTranscript(t, os.Getenv("CLAUDE_PROJECTS_DIR"), goneSID)
	prev := wakeResumeCheckAfter
	wakeResumeCheckAfter = 200 * time.Millisecond
	t.Cleanup(func() { wakeResumeCheckAfter = prev })

	g.wake(t)
	logFile := naming.LogFile(g.h.cfg.LogDir, "claude", goneSID)
	require.NoError(t, os.MkdirAll(filepath.Dir(logFile), 0o700))
	require.NoError(t, os.WriteFile(logFile, []byte("No conversation found with session ID: "+goneSID+"\n"), 0o600))
	g.term.setFG(g.name, "node") // the CLI is alive after all: the backstop's wake finds a running agent and launches nothing
	before := len(g.term.sentTo(g.name + ".0"))

	require.Eventually(t, func() bool { _, ok := resumeGone.Load(goneSID); return !ok }, 3*time.Second, 20*time.Millisecond)
	time.Sleep(600 * time.Millisecond) // sleep-ok: the backstop has run and its wake has returned; nothing more is coming
	assert.Equal(t, before, len(g.term.sentTo(g.name+".0")), "nothing was typed: the CLI was alive")
	_, left := resumeGone.Load(goneSID)
	assert.False(t, left, "no flag left behind")
	assert.False(t, forceFresh(goneSID), "so a later wake does not start fresh on a stale note")

	// An old note is not believed either.
	resumeGone.Store(goneSID, time.Now().Add(-2*resumeGoneLife))
	assert.False(t, forceFresh(goneSID), "a note older than a minute counts for nothing")
	resumeGone.Store(goneSID, time.Now())
	assert.True(t, forceFresh(goneSID), "a fresh one does")
}

// ... and when the backstop's wake fails before it gets as far as deciding (a CLI path that is refused), the note is not left either.
func TestTheBackstopLeavesNoFlagWhenItsWakeFailed(t *testing.T) {
	g := newGoneRig(t)
	writeTranscript(t, os.Getenv("CLAUDE_PROJECTS_DIR"), goneSID)
	prev := wakeResumeCheckAfter
	wakeResumeCheckAfter = 200 * time.Millisecond
	t.Cleanup(func() { wakeResumeCheckAfter = prev })

	g.wake(t)
	require.NoError(t, g.ss.SetSetting(context.Background(), "cli_path_claude", filepath.Join(t.TempDir(), "no-such-claude"))) // the next wake is refused at the CLI
	logFile := naming.LogFile(g.h.cfg.LogDir, "claude", goneSID)
	require.NoError(t, os.MkdirAll(filepath.Dir(logFile), 0o700))
	require.NoError(t, os.WriteFile(logFile, []byte("No conversation found with session ID: "+goneSID+"\n"), 0o600))
	g.term.setFG(g.name, "zsh")

	time.Sleep(1500 * time.Millisecond) // sleep-ok: the backstop looks at 200 ms and its refused wake returns at once
	_, left := resumeGone.Load(goneSID)
	assert.False(t, left, "a wake that failed leaves no note for a later one")
}

// Codex And Security Review on #12714: an agent whose Claude uses a config folder of its own (CLAUDE_CONFIG_DIR) that Coral's environment does not name is never started fresh on a lookup that could not have found it.
func TestAnAgentWithAConfigFolderOfItsOwnIsResumedNotCalledGone(t *testing.T) {
	g := newGoneRig(t) // Coral's projects folder holds nothing...
	own := t.TempDir() // ...the agent's own CLAUDE_CONFIG_DIR does: its transcript is there
	writeTranscript(t, filepath.Join(own, "projects"), goneSID)

	g.wake(t) // Coral never read a transcript of this session (it could not see where it is): no evidence it ever existed

	cmds := g.launchLines()
	assert.Contains(t, cmds, "--resume "+goneSID, "resumed: the agent's own Claude finds its own conversation")
	assert.NotContains(t, cmds, "--session-id")
	assert.Equal(t, 0, g.notes(), "no false 'could not resume'")
}

// The line only counts when it was written after this resume (Codex And Security Review on #12714).
func TestAnOlderLineInTheLogIsNotThisResumesLine(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "agent.log")
	line := "No conversation found with session ID: x\n"
	require.NoError(t, os.WriteFile(log, []byte("old run\n"+line+"$ \n"), 0o600))
	off := logSize(log)
	assert.False(t, logHasSince(log, off, conversationGoneLine), "an older run's line in the same log is not this one's")
	f, err := os.OpenFile(log, os.O_APPEND|os.O_WRONLY, 0o600)
	require.NoError(t, err)
	_, err = f.WriteString("$ claude --resume y\n" + line)
	require.NoError(t, err)
	require.NoError(t, f.Close())
	assert.True(t, logHasSince(log, off, conversationGoneLine), "a line after the offset is")
	require.NoError(t, os.WriteFile(log, []byte(line), 0o600)) // the log was reset: shorter than the offset, so all of it is new
	assert.True(t, logHasSince(log, off+1000, conversationGoneLine), "a reset log is read whole")
	assert.False(t, logHasSince(filepath.Join(dir, "none.log"), 0, conversationGoneLine), "no log, no line")
	link := filepath.Join(dir, "link.log")
	require.NoError(t, os.Symlink(log, link))
	assert.False(t, logHasSince(link, 0, conversationGoneLine), "never through a link")
}

func TestTheBackstopIgnoresALineThatWasThereBeforeItsResume(t *testing.T) {
	g := newGoneRig(t)
	writeTranscript(t, os.Getenv("CLAUDE_PROJECTS_DIR"), goneSID)
	prev := wakeResumeCheckAfter
	t.Cleanup(func() { wakeResumeCheckAfter = prev })
	wakeResumeCheckAfter = 24 * time.Hour // the wake's own backstop never fires in this test: the one under test is started by hand below
	g.wake(t)
	wakeResumeCheckAfter = 200 * time.Millisecond
	before := len(g.term.sentTo(g.name + ".0"))
	logFile := naming.LogFile(g.h.cfg.LogDir, "claude", goneSID)
	require.NoError(t, os.MkdirAll(filepath.Dir(logFile), 0o700))
	require.NoError(t, os.WriteFile(logFile, []byte("an earlier run\nNo conversation found with session ID: "+goneSID+"\n"), 0o600))
	g.term.setFG(g.name, "zsh")
	ls, err := g.ss.GetLiveSession(context.Background(), goneSID)
	require.NoError(t, err)

	g.h.watchResumeGone(ls, logSize(logFile)) // the offset is taken now, after the old line

	time.Sleep(1200 * time.Millisecond) // sleep-ok: the backstop looks at 200 ms
	assert.Equal(t, before, len(g.term.sentTo(g.name+".0")), "nothing started fresh on an old line")
	assert.Equal(t, 0, g.notes())
}

// Orchestrator's line on #12714: the offset is taken before the launch line is typed, so a "No conversation found" the CLI prints the instant it starts (while the launch is still being typed) is this resume's line and is seen.
func TestALinePrintedAtOnceAfterTheLaunchIsSeen(t *testing.T) {
	g := newGoneRig(t)
	writeTranscript(t, os.Getenv("CLAUDE_PROJECTS_DIR"), goneSID)
	prev := wakeResumeCheckAfter
	wakeResumeCheckAfter = 300 * time.Millisecond
	t.Cleanup(func() { wakeResumeCheckAfter = prev })
	logFile := naming.LogFile(g.h.cfg.LogDir, "claude", goneSID)
	require.NoError(t, os.MkdirAll(filepath.Dir(logFile), 0o700))
	first := true
	g.term.mockSessionTerminal.onSend = func(target string) { // as the launch line is typed, the CLI already prints its line
		if first {
			first = false
			f, err := os.OpenFile(logFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
			require.NoError(t, err)
			_, err = f.WriteString("No conversation found with session ID: " + goneSID + "\n")
			require.NoError(t, err)
			require.NoError(t, f.Close())
			g.term.setFG(g.name, "zsh")
		}
	}

	g.wake(t)

	require.Eventually(t, func() bool { return strings.Contains(g.launchLines(), "--session-id "+goneSID) }, 5*time.Second, 50*time.Millisecond,
		"the line printed with the launch was this resume's: %q", g.launchLines())
}
