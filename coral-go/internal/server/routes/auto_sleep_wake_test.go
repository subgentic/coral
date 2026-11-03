package routes

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/store"
)

func (r *sleepRig) autoSleep(t *testing.T) {
	t.Helper()
	require.NoError(t, r.ss.SetSessionAutoSleeping(r.ctx, r.sid, time.Now()))
}

// A delivery wakes an auto-asleep agent and the clock for the thrash guard is written; the wake types the CLI's launch line and nothing else (no first prompt, no join text).
func TestWakeIdleForDeliveryWakesAnAutoAsleepAgent(t *testing.T) {
	r := newSleepRig(t)
	_, err := r.ss.SetPrompt(r.ctx, r.sid, ptr.NonEmpty("UNIQUE-FIRST-PROMPT-TEXT"))
	require.NoError(t, err)
	r.autoSleep(t)
	require.True(t, r.h.WakeIdleForDelivery(r.ctx, r.sid))
	ls, _ := r.ss.GetLiveSession(r.ctx, r.sid)
	assert.Equal(t, 0, ls.IsSleeping)
	assert.Nil(t, ls.SleepReason, "the reason idle is cleared by the wake")
	st, _ := r.ss.AutoSleepStateOf(r.ctx, r.sid)
	assert.NotZero(t, st.WokenAt, "the wake is on the thrash guard's clock")
	r.term.mu.Lock()
	defer r.term.mu.Unlock()
	for target, lines := range r.term.sent {
		for _, l := range lines {
			assert.NotContains(t, l, "UNIQUE-FIRST-PROMPT-TEXT", "the launch prompt is not sent again (%s)", target)
		}
	}
}

// A manual sleeper and an archived agent are never woken by a delivery; an awake one is already up.
func TestWakeIdleForDeliveryNeverWakesAManualSleeper(t *testing.T) {
	r := newSleepRig(t)
	require.NoError(t, r.ss.SetSessionSleeping(r.ctx, r.sid, true))
	assert.False(t, r.h.WakeIdleForDelivery(r.ctx, r.sid), "a person's Sleep stays")
	ls, _ := r.ss.GetLiveSession(r.ctx, r.sid)
	assert.Equal(t, 1, ls.IsSleeping)

	r2 := newSleepRig(t)
	assert.True(t, r2.h.WakeIdleForDelivery(r2.ctx, r2.sid), "an awake agent is up")
	r3 := newSleepRig(t)
	r3.autoSleep(t)
	require.NoError(t, r3.ss.SetSessionArchived(r3.ctx, r3.sid, true))
	assert.False(t, r3.h.WakeIdleForDelivery(r3.ctx, r3.sid), "an archived agent is not woken")
	assert.False(t, r3.h.WakeIdleForDelivery(r3.ctx, "no-such-session"))
}

// The stored folder is gone: the agent is not woken, becomes a plain sleeper with the failure marked, and the board is told (Security: it does not look available for ever).
func TestWakeIdleForDeliveryWithTheFolderGone(t *testing.T) {
	r := newSleepRig(t)
	gone := t.TempDir() + "/deleted"
	_, err := r.h.db.DB.ExecContext(r.ctx, `UPDATE live_sessions SET working_dir = ? WHERE session_id = ?`, gone, r.sid)
	require.NoError(t, err)
	r.autoSleep(t)
	assert.False(t, r.h.WakeIdleForDelivery(r.ctx, r.sid))
	ls, _ := r.ss.GetLiveSession(r.ctx, r.sid)
	assert.Equal(t, 1, ls.IsSleeping, "still asleep")
	assert.Equal(t, "", sleepReasonOf(ls), "no longer auto-asleep: nothing may count it as available")
	assert.Equal(t, store.StartFailureFolderGone, ptr.Value(ls.StartFailure))
	msgs, err := r.h.bs.ListMessages(r.ctx, "autosleep", 50, 0, 0)
	require.NoError(t, err)
	var told bool
	for _, m := range msgs {
		told = told || strings.Contains(m.Content, "folder this agent worked in is gone")
	}
	assert.True(t, told, "the board is told once")
}

func sleepReasonOf(ls *store.LiveSession) string { return ptr.Value(ls.SleepReason) }

// Woken within ten minutes of its auto-sleep, the agent is not put to sleep again for two hours.
func TestAutoSleepThrashGuardEndToEnd(t *testing.T) {
	r := newSleepRig(t)
	r.autoSleep(t)
	require.True(t, r.h.WakeIdleForDelivery(r.ctx, r.sid))
	ls := r.passAfter(t, 62*time.Minute) // idle again for over an hour, but woken at once after its sleep: held awake for two hours from the wake
	assert.Equal(t, 0, ls.IsSleeping, "the thrash guard holds it awake")
	ls = r.passAfter(t, 3*time.Hour) // past the two hours: asleep again
	assert.Equal(t, 1, ls.IsSleeping, "and the guard ends")
}

// What wakes an auto-asleep agent from the board: a message that mentions it, or a task assigned to it. A broadcast that names no one, "@all" included, and a manual sleeper do not.
func TestAutoAsleepNeedsAreDirectedOnly(t *testing.T) {
	r := newSleepRig(t)
	r.h.bs.SetSessionsDB(r.h.db.DB)
	r.autoSleep(t)
	need := func() int {
		t.Helper()
		ns, err := r.h.bs.AutoAsleepNeeds(r.ctx, nil)
		require.NoError(t, err)
		for _, n := range ns {
			assert.Equal(t, r.sid, n.SessionID)
		}
		return len(ns)
	}
	_, err := r.h.bs.Subscribe(r.ctx, "autosleep", "lead", "Lead", "claude-"+"11111111-1111-4111-8111-111111111111", nil, "all")
	require.NoError(t, err)
	post := func(text string) {
		_, err := r.h.bs.PostMessage(r.ctx, "autosleep", "lead", text, nil)
		require.NoError(t, err)
	}
	post("status for everyone, nothing for anybody")
	post("@all please read the new rules")
	assert.Equal(t, 0, need(), "a broadcast, @all included, wakes no one")
	post("@Developer can you look at the failing test")
	assert.Equal(t, 1, need(), "a message that mentions the agent wakes it")

	r2 := newSleepRig(t)
	r2.h.bs.SetSessionsDB(r2.h.db.DB)
	r2.autoSleep(t)
	_, err = r2.h.bs.CreateTask(r2.ctx, "autosleep", "Do the thing", "", "high", "lead", "dev")
	require.NoError(t, err)
	ns, err := r2.h.bs.AutoAsleepNeeds(r2.ctx, nil)
	require.NoError(t, err)
	assert.Len(t, ns, 1, "a task assigned to it wakes it")

	r3 := newSleepRig(t)
	r3.h.bs.SetSessionsDB(r3.h.db.DB)
	require.NoError(t, r3.ss.SetSessionSleeping(r3.ctx, r3.sid, true))
	_, err = r3.h.bs.CreateTask(r3.ctx, "autosleep", "Do the thing", "", "high", "lead", "dev")
	require.NoError(t, err)
	ns, err = r3.h.bs.AutoAsleepNeeds(r3.ctx, nil)
	require.NoError(t, err)
	assert.Empty(t, ns, "a person's Sleep is never woken by the board")
}

// Eleven task assignments to eleven sleepers on one board wake ten (Security, #12111): the board's hourly cap is inside the wake, so every path counts. The person's own Send is exempt.
func TestWakeIdleForDeliveryHoldsTheBoardsHourlyCap(t *testing.T) {
	old := deliveryWakeGap
	deliveryWakeGap = 0
	t.Cleanup(func() { deliveryWakeGap = old })
	r := newSleepRig(t)
	autoWakeSlots.Lock()
	autoWakeSlots.m["autosleep"] = nil // other tests of this package may have used the board's name
	autoWakeSlots.Unlock()
	team := "autosleep"
	sids := []string{r.sid}
	for i := 0; i < 10; i++ {
		sid := fmt.Sprintf("00000000-0000-4000-8000-%012d", 500+i)
		require.NoError(t, r.ss.RegisterLiveSession(r.ctx, &store.LiveSession{SessionID: sid, AgentName: fmt.Sprintf("dev%d", i), AgentType: "claude", BoardName: &team, WorkingDir: "/tmp"}))
		sids = append(sids, sid)
	}
	for _, sid := range sids {
		require.NoError(t, r.ss.SetSessionAutoSleeping(r.ctx, sid, time.Now()))
	}
	woken := 0
	for _, sid := range sids {
		if r.h.WakeIdleForDelivery(r.ctx, sid) {
			woken++
		}
	}
	assert.Equal(t, 10, woken, "eleven sleepers, ten wakes in the hour")
	last, _ := r.ss.GetLiveSession(r.ctx, sids[10])
	assert.Equal(t, 1, last.IsSleeping, "the eleventh stays asleep: its delivery waits")
	assert.True(t, r.h.WakeIdleFor(r.ctx, sids[10], true), "the person's own Send is not held by the cap")
}

// At most two wakes run at once and they start apart.
func TestPaceWakeStartsWakesApart(t *testing.T) {
	old := deliveryWakeGap
	deliveryWakeGap = 30 * time.Millisecond
	t.Cleanup(func() { deliveryWakeGap = old })
	var starts []time.Time
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			release, ok := paceWake(context.Background())
			require.True(t, ok)
			mu.Lock()
			starts = append(starts, time.Now())
			mu.Unlock()
			time.Sleep(5 * time.Millisecond)
			release()
		}()
	}
	wg.Wait()
	sort.Slice(starts, func(i, j int) bool { return starts[i].Before(starts[j]) })
	for i := 1; i < len(starts); i++ {
		assert.GreaterOrEqual(t, starts[i].Sub(starts[i-1]), 25*time.Millisecond, "wake %d started too soon after the one before", i)
	}
}

// A wake that cannot start (the folder is gone) does not use one of the board's ten (QA's SHOULD 2).
func TestAGoneFolderDoesNotUseABoardWakeSlot(t *testing.T) {
	r := newSleepRig(t)
	autoWakeSlots.Lock()
	autoWakeSlots.m["autosleep"] = nil
	autoWakeSlots.Unlock()
	_, err := r.h.db.DB.ExecContext(r.ctx, `UPDATE live_sessions SET working_dir = ? WHERE session_id = ?`, t.TempDir()+"/deleted", r.sid)
	require.NoError(t, err)
	r.autoSleep(t)
	assert.False(t, r.h.WakeIdleForDelivery(r.ctx, r.sid))
	autoWakeSlots.Lock()
	used := len(autoWakeSlots.m["autosleep"])
	autoWakeSlots.Unlock()
	assert.Equal(t, 0, used, "no slot was taken for a wake that could not start")
}

// promptFilesOf reads the files a typed launch line passes to the CLI as the first message: `"$(cat '<file>')"` after the `--`.
func promptFilesOf(t *testing.T, r *sleepRig) []string {
	t.Helper()
	r.term.mu.Lock()
	defer r.term.mu.Unlock()
	var out []string
	re := regexp.MustCompile(`-- "\$\(cat '([^']+)'\)"`)
	for _, lines := range r.term.sent {
		for _, l := range lines {
			for _, m := range re.FindAllStringSubmatch(l, -1) {
				b, err := os.ReadFile(m[1])
				require.NoError(t, err, "the launch line names a prompt file that is there")
				out = append(out, string(b))
			}
		}
	}
	return out
}

// The operator's call (#12358): an auto-asleep agent woken by a delivery is started without its first message, because the delivery that woke it says what to do; a manual Wake sends it as it always did.
func TestAutoWakeSendsNoStartingPromptAndAManualWakeDoes(t *testing.T) {
	const first = "UNIQUE-FIRST-PROMPT-TEXT"
	t.Run("auto wake", func(t *testing.T) {
		autoWakeSlots.Lock() // the board's hourly cap is process-wide: the other tests' wakes on this board are not this test's
		delete(autoWakeSlots.m, "autosleep")
		autoWakeSlots.Unlock()
		r := newSleepRig(t)
		haveClaudeConversation(t, r.sid)
		_, err := r.ss.SetPrompt(r.ctx, r.sid, ptr.NonEmpty(first))
		require.NoError(t, err)
		r.autoSleep(t)
		require.NoError(t, r.term.mockSessionTerminal.KillSessionOnly(r.ctx, r.name, "claude", r.sid)) // a real sleep ended its terminal: the wake starts a new one
		require.True(t, r.h.WakeIdleForDelivery(r.ctx, r.sid))
		launched := promptFilesOf(t, r)
		require.NotEmpty(t, r.term.sent, "the wake typed a launch line")
		for _, p := range launched {
			assert.NotContains(t, p, first, "the first prompt is not sent again")
			assert.NotContains(t, p, "automatically joined", "nor the board's join text")
		}
	})
	t.Run("manual wake", func(t *testing.T) {
		r := newSleepRig(t)
		haveClaudeConversation(t, r.sid)
		_, err := r.ss.SetPrompt(r.ctx, r.sid, ptr.NonEmpty(first))
		require.NoError(t, err)
		require.NoError(t, r.ss.SetSessionSleeping(r.ctx, r.sid, true))
		require.NoError(t, r.term.mockSessionTerminal.KillSessionOnly(r.ctx, r.name, "claude", r.sid))
		ls, err := r.ss.GetLiveSession(r.ctx, r.sid)
		require.NoError(t, err)
		require.NoError(t, r.h.wakeExistingSession(r.ctx, ls))
		files := promptFilesOf(t, r)
		require.NotEmpty(t, files, "a manual wake passes its first message: %v", r.term.sent)
		assert.Contains(t, strings.Join(files, "\n"), first, "the first prompt is sent as before")
	})
}

// A launch that starts a NEW conversation has none to lean on, so it keeps its first message even on an auto-wake (QA's SHOULD, #12358): Codex with no saved session is started without a resume id.
func TestAutoWakeOfALaunchThatDoesNotResumeKeepsItsFirstMessage(t *testing.T) {
	r := newSleepRig(t)
	haveClaudeConversation(t, r.sid)
	truePath, lerr := exec.LookPath("true")
	if lerr != nil {
		t.Skip("no true(1) to stand in for the Codex CLI")
	}
	require.NoError(t, r.ss.SetSetting(r.ctx, "cli_path_codex", truePath))
	cx := uuid.NewString()
	team := "autosleep"
	require.NoError(t, r.ss.RegisterLiveSession(r.ctx, &store.LiveSession{SessionID: cx, AgentName: "cx", AgentType: "codex", BoardName: &team, WorkingDir: t.TempDir()}))
	ls, err := r.ss.GetLiveSession(r.ctx, cx)
	require.NoError(t, err)
	plan, err := r.h.prepareWake(r.ctx, ls, true)
	require.NoError(t, err)
	assert.Empty(t, plan.params.ResumeSessionID, "a Codex agent with no saved conversation is started anew")
	assert.False(t, plan.params.NoStartPrompt, "so it keeps its first message")
	claude, err := r.ss.GetLiveSession(r.ctx, r.sid)
	require.NoError(t, err)
	plan, err = r.h.prepareWake(r.ctx, claude, true)
	require.NoError(t, err)
	assert.NotEmpty(t, plan.params.ResumeSessionID)
	assert.True(t, plan.params.NoStartPrompt, "a resumed Claude conversation goes without")
}
