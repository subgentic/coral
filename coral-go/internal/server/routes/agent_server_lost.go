package routes

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/background"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/store"
)

// The terminal server going away (#12592). Coral's tmux server ended on a Mac with every agent in it and nothing said so: the reconciler found each agent missing, one by one, and a Coral that did not own
// its data folder woke none. The reconciler now reports the loss once (background.ServerLoss); this is what the Operator and the agents are told, and the recovery.
//   - A dashboard notice and one board notice per team say when it happened, how many agents it took and what happens next.
//   - Coral wakes the agents again (resume, the same wake as the dashboard's), one every recoverSpacing so a dozen terminals do not start at once. Only an agent still asleep because its terminal was lost is woken: one that a
//     person woke, archived or put to sleep for another reason since is left alone.
//   - A second loss within recoverGuard of the last recovery wakes nobody: a server that keeps dying is not restarted into a loop, and the notice says to wake the agents by hand. That is the only reason not to wake.
const (
	recoverSpacing = 3 * time.Second
	recoverGuard   = 10 * time.Minute
)

// ServerLost hears the reconciler's report that the terminal server went away under the agents in loss.
func (h *SessionsHandler) ServerLost(ctx context.Context, loss background.ServerLoss) {
	var lost []string // read again now: the agents still asleep because of the lost terminal
	for _, sid := range loss.SessionIDs {
		if h.asleepForLostTerminal(ctx, sid) != nil {
			lost = append(lost, sid)
		}
	}
	if len(lost) == 0 {
		return
	}
	h.exits.mu.Lock()
	again := !h.exits.lastRecover.IsZero() && time.Since(h.exits.lastRecover) < recoverGuard
	recover := !again
	if recover {
		h.exits.lastRecover = time.Now()
	}
	h.exits.mu.Unlock()

	plan := "Coral is waking them again, one at a time"
	if again {
		plan = "it stopped again within " + recoverGuard.String() + " of the last recovery, so Coral wakes none: Wake resumes each agent"
	}
	at := loss.At.Local().Format("15:04:05")
	head := fmt.Sprintf("The terminal server stopped at %s", at)
	body := fmt.Sprintf("%d agents lost their terminals with it (last pid %d); %s.", len(lost), loss.PID, plan)
	if len(lost) == 1 {
		body = fmt.Sprintf("1 agent lost its terminal with it (last pid %d); %s.", loss.PID, plan)
	}
	slog.Warn("[terminal-server] lost", "time", at, "last_pid", loss.PID, "agents", len(lost), "recovering", recover)
	if h.notifications != nil {
		h.notifications.Push(Notification{Title: head, Message: body, Level: "warning"})
	}
	teams := map[string][]string{} // team -> the names lost on it
	for _, sid := range lost {
		ls := h.asleepForLostTerminal(ctx, sid)
		if ls == nil {
			continue
		}
		if team := ptr.Value(ls.BoardName); team != "" {
			teams[team] = append(teams[team], h.noticeName(ctx, *ls))
		}
	}
	if h.bs != nil {
		for team, names := range teams {
			if len(names) > exitNoticeMaxAgents {
				names = append(names[:exitNoticeMaxAgents], fmt.Sprintf("and %d more", len(names)-exitNoticeMaxAgents))
			}
			content := head + ": " + strings.Join(names, ", ") + ". " + strings.ToUpper(plan[:1]) + plan[1:] + "."
			if _, err := h.bs.PostSystemMessage(ctx, team, exitNoticeSender, content, nil); err != nil {
				slog.Warn("[terminal-server] notice not posted", "board", team, "err", err)
			}
		}
	}
	if !recover {
		return
	}
	for i, sid := range lost {
		sid := sid
		h.exits.after(time.Duration(i)*recoverSpacing, func() { h.recoverAgent(context.Background(), sid) })
	}
}

// recoverAgent wakes one agent of a lost terminal server, unless it was woken, archived or ended meanwhile.
func (h *SessionsHandler) recoverAgent(ctx context.Context, sid string) {
	ls := h.asleepForLostTerminal(ctx, sid)
	if ls == nil {
		return
	}
	if err := h.wakeExistingSession(ctx, ls); err != nil {
		slog.Warn("[terminal-server] wake after the loss failed", "session_id", sid, "err", err)
		return
	}
	slog.Info("[terminal-server] woke an agent after the loss", "session_id", sid)
	if title := h.noticeName(ctx, *ls); title != "" && h.bs != nil && ptr.Value(ls.BoardName) != "" {
		if _, err := h.bs.PostSystemMessage(ctx, ptr.Value(ls.BoardName), board.CoralSender, "@"+title+" "+ServerLostNotice, nil); err != nil {
			slog.Warn("[terminal-server] wake notice not posted", "err", err)
		}
	}
}

// asleepForLostTerminal is the agent's row when it is still asleep because its terminal was lost (not woken, archived or put to sleep for another reason since), else nil.
func (h *SessionsHandler) asleepForLostTerminal(ctx context.Context, sid string) *store.LiveSession {
	ls, err := h.ss.GetLiveSession(ctx, sid)
	if err != nil || ls == nil || ls.IsSleeping != 1 || ls.IsArchived == 1 || ptr.Value(ls.SleepReason) != store.SleepReasonTerminalGone {
		return nil
	}
	return ls
}

// ServerLostNotice is the fixed text of Coral's board notice to an agent it woke after the terminal server was lost.
const ServerLostNotice = "Coral's terminal server stopped and ended your terminal; Coral resumed you. Check your last step before you continue."
