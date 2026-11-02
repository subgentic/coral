package routes

import (
	"context"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// The wake half of auto-sleep (#12111): any delivery from Coral to an auto-asleep agent (sleep_reason idle) wakes it first and waits until it is up, then goes on exactly as to an awake
// agent. A manual sleeper is never woken here: a person's Sleep stays a person's decision.

const (
	autoWakeReadyWait  = 90 * time.Second // how long a delivery waits for the agent's input box
	autoWakeReadyEvery = time.Second
)

// autoWakeLocks serialises the wakes of one agent: several deliveries arriving together start it once.
var autoWakeLocks sync.Map // session id -> *sync.Mutex

// WakeIdleForDelivery wakes the session when it is auto-asleep and reports whether the agent is awake afterwards (true as well for one that was awake already). It never wakes a manual
// sleeper or an archived agent. It uses exactly what the row stored: the agent's own flags, permission mode and folder, never today's defaults; an agent whose stored folder is gone is not
// woken, and says so on its page and its board. A wake that fails leaves a plain sleeping row (reason cleared) with the failure marked, so the health check's "asleep with tasks" and the
// refused-start item apply to it, and it does not look available for ever.
func (h *SessionsHandler) WakeIdleForDelivery(ctx context.Context, sessionID string) bool {
	return h.WakeIdleFor(ctx, sessionID, false)
}

// WakeIdleFor is WakeIdleForDelivery with who asked: a person's own Send is exempt from the board's hourly cap (the Operator typed to that agent), everything else counts against it (Security,
// #12111): an agent that can assign tasks cannot wake every sleeper on its board, once each per idle period, without limit. A wake refused for the cap leaves the delivery where it was (unread,
// queued) and logs one counter line; at most two wakes run at once and they start two seconds apart.
func (h *SessionsHandler) WakeIdleFor(ctx context.Context, sessionID string, fromPerson bool) bool {
	if !fromPerson && ptymanager.Foreign() { // a delivery's wake starts a CLI by itself: not in a Coral on a copy of another's database; a person's own Send is a person's action (internal/dataowner)
		return false
	}
	ls, err := h.ss.GetLiveSession(ctx, sessionID)
	if err != nil || ls == nil {
		return false
	}
	if ls.IsSleeping == 0 {
		return true
	}
	if ls.IsArchived != 0 || sleepReason(*ls) != store.SleepReasonIdle {
		return false
	}
	mu, _ := autoWakeLocks.LoadOrStore(sessionID, &sync.Mutex{})
	mu.(*sync.Mutex).Lock()
	defer mu.(*sync.Mutex).Unlock()
	if ls, err = h.ss.GetLiveSession(ctx, sessionID); err != nil || ls == nil {
		return false
	}
	if ls.IsSleeping == 0 { // another delivery woke it while this one waited
		return true
	}
	if ls.IsArchived != 0 || sleepReason(*ls) != store.SleepReasonIdle {
		return false
	}
	start := time.Now()
	ctx, cancel := lifecycleCtx(ctx) // a wake runs to its end whatever asked for it (#5171)
	defer cancel()
	dir := ls.WorkingDir
	if tdir := h.teamHomeFolder(ctx, ls); tdir != "" {
		dir = tdir
	}
	if info, serr := os.Stat(dir); serr != nil || !info.IsDir() { // checked first: a wake that cannot start does not use one of the board's ten (QA's SHOULD 2)
		h.autoWakeFailed(ctx, ls, store.StartFailureFolderGone, nil)
		return false
	}
	if !fromPerson && !takeBoardWakeSlot(ptr.Value(ls.BoardName), time.Now()) {
		noteWakeHeld(ptr.Value(ls.BoardName), time.Now())
		return false
	}
	release, ok := paceWake(ctx)
	if !ok {
		return false
	}
	defer release()
	if err := h.wakeSession(ctx, ls, true); err != nil { // no starting prompt: the delivery that woke it says what to do (#12358)
		h.autoWakeFailed(ctx, ls, store.StartFailureWakeFailed, err)
		return false
	}
	_ = h.ss.NoteAutoWoken(ctx, ls.SessionID, time.Now())
	name := naming.SessionName(ls.AgentType, ls.SessionID)
	ready := h.waitForInputBox(ctx, name, ls.AgentType, ls.SessionID)
	slog.Info("auto_wake", "session_id", ls.SessionID, "agent_type", ls.AgentType, "wake_latency_ms", time.Since(start).Milliseconds(), "input_box_ready", ready)
	h.kickWS()
	return true
}

// autoWakeFailed ends an auto-sleep whose wake did not happen: the row becomes a plain sleeper (the reason idle is cleared: it is no longer available to anyone) with the failure marked,
// which the page shows and the board is told once (markStartRefused's post).
func (h *SessionsHandler) autoWakeFailed(ctx context.Context, ls *store.LiveSession, code string, cause error) {
	slog.Warn("auto_wake failed", "session_id", ls.SessionID, "reason", code, "error", cause)
	_ = h.ss.SetSessionSleeping(ctx, ls.SessionID, true)
	_ = h.ss.ClearAutoSleepClocks(ctx, ls.SessionID)
	if err := h.ss.SetStartFailure(ctx, ls.SessionID, code); err != nil {
		return
	}
	if h.bs == nil || ptr.Value(ls.BoardName) == "" {
		return
	}
	if title := h.noticeName(ctx, *ls); title != "" {
		_, _ = h.bs.PostSystemMessage(ctx, ptr.Value(ls.BoardName), board.CoralSender, "@"+title+" "+startFailureSentence(ls.AgentType, code), nil)
	}
	h.kickWS()
}

// waitForInputBox waits for the woken agent's input box to be on its screen (up to autoWakeReadyWait), so the delivery that woke it types into a box, not into the shell's launch line. A
// terminal with no screen to read is not waited for.
func (h *SessionsHandler) waitForInputBox(ctx context.Context, name, agentType, sessionID string) bool {
	r, ok := h.terminal.(ptymanager.ScreenReader)
	if !ok {
		return false
	}
	deadline := time.Now().Add(autoWakeReadyWait)
	for time.Now().Before(deadline) {
		if screen, err := r.AgentScreen(ctx, name, agentType, sessionID); err == nil && ptymanager.InputBoxOnScreen(screen) {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(autoWakeReadyEvery):
		}
	}
	return false
}

// autoWakeBoardCap is the most agents one board's deliveries wake in an hour (Security, #12111).
const autoWakeBoardCap = 10

// deliveryWakeGap is how far apart two wakes start; a var so a test need not wait.
var deliveryWakeGap = 2 * time.Second

var (
	autoWakeSlots = struct {
		sync.Mutex
		m map[string][]time.Time
	}{m: map[string][]time.Time{}}
	autoWakeHeldLogged = struct {
		sync.Mutex
		m map[string]time.Time
	}{m: map[string]time.Time{}}
	autoWakeSem  = make(chan struct{}, 2) // at most two wakes at once
	autoWakePace struct {
		sync.Mutex
		last time.Time
	}
)

// takeBoardWakeSlot counts one wake against the board's sliding hour; false at the cap.
func takeBoardWakeSlot(board string, now time.Time) bool {
	autoWakeSlots.Lock()
	defer autoWakeSlots.Unlock()
	kept := autoWakeSlots.m[board][:0]
	for _, t := range autoWakeSlots.m[board] {
		if now.Sub(t) < time.Hour {
			kept = append(kept, t)
		}
	}
	if len(kept) >= autoWakeBoardCap {
		autoWakeSlots.m[board] = kept
		return false
	}
	autoWakeSlots.m[board] = append(kept, now)
	return true
}

// noteWakeHeld logs a wake refused for the cap, once per board per ten minutes: a pass that asks again and again does not fill the log.
func noteWakeHeld(board string, now time.Time) {
	autoWakeHeldLogged.Lock()
	defer autoWakeHeldLogged.Unlock()
	if last, ok := autoWakeHeldLogged.m[board]; ok && now.Sub(last) < 10*time.Minute {
		return
	}
	autoWakeHeldLogged.m[board] = now
	slog.Warn("auto_wake held: the board's hourly cap", "cap", autoWakeBoardCap)
}

// paceWake waits for one of the two wake places and for the gap since the last wake started; release gives the place back. false when ctx ended first.
func paceWake(ctx context.Context) (release func(), ok bool) {
	select {
	case autoWakeSem <- struct{}{}:
	case <-ctx.Done():
		return nil, false
	}
	autoWakePace.Lock()
	wait := deliveryWakeGap - time.Since(autoWakePace.last)
	autoWakePace.last = time.Now().Add(max(wait, 0))
	autoWakePace.Unlock()
	if wait > 0 {
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			<-autoWakeSem
			return nil, false
		}
	}
	return func() { <-autoWakeSem }, true
}
