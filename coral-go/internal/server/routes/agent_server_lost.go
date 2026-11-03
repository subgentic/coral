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
	"github.com/subgentic/coral/internal/ptymanager"
)

// The terminal server going away (#12592). Coral's tmux server ended on a Mac with every agent in it and nothing said so: the reconciler found each agent missing, one by one, and a Coral that did not own
// its data folder woke none. The reconciler now reports the loss once (background.ServerLoss); this is what the Operator and the agents are told, and the recovery.
//   - A dashboard notice and one board notice per team say when it happened, how many agents it took and what happens next.
//   - When this Coral owns its data folder it wakes the agents again (resume, the same wake as the dashboard's), one every recoverSpacing so a dozen terminals do not start at once.
//   - A second loss within recoverGuard of the last recovery wakes nobody: a server that keeps dying is not restarted into a loop, and the notice says to wake the agents by hand.
const (
	recoverSpacing = 3 * time.Second
	recoverGuard   = 10 * time.Minute
)

// ServerLost hears the reconciler's report that the terminal server went away under the agents in loss.
func (h *SessionsHandler) ServerLost(ctx context.Context, loss background.ServerLoss) {
	owned := ptymanager.RefuseIfForeign() == nil
	h.exits.mu.Lock()
	again := !h.exits.lastRecover.IsZero() && time.Since(h.exits.lastRecover) < recoverGuard
	recover := owned && !again
	if recover {
		h.exits.lastRecover = time.Now()
	}
	h.exits.mu.Unlock()

	plan := "Coral is waking them again, one at a time"
	switch {
	case !owned:
		plan = "this Coral does not own this data folder, so it wakes none: Wake resumes each agent"
	case again:
		plan = "it stopped again within " + recoverGuard.String() + " of the last recovery, so Coral wakes none: Wake resumes each agent"
	}
	at := loss.At.Local().Format("15:04:05")
	head := fmt.Sprintf("The terminal server stopped at %s", at)
	body := fmt.Sprintf("%d agents lost their terminals with it (last pid %d); %s.", len(loss.SessionIDs), loss.PID, plan)
	if len(loss.SessionIDs) == 1 {
		body = fmt.Sprintf("1 agent lost its terminal with it (last pid %d); %s.", loss.PID, plan)
	}
	slog.Warn("[terminal-server] lost", "time", at, "last_pid", loss.PID, "agents", len(loss.SessionIDs), "recovering", recover)
	if h.notifications != nil {
		h.notifications.Push(Notification{Title: head, Message: body, Level: "warning"})
	}
	teams := map[string][]string{} // team -> the names lost on it
	for _, sid := range loss.SessionIDs {
		ls, err := h.ss.GetLiveSession(ctx, sid)
		if err != nil || ls == nil {
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
	for i, sid := range loss.SessionIDs {
		sid := sid
		h.exits.after(time.Duration(i)*recoverSpacing, func() { h.recoverAgent(context.Background(), sid) })
	}
}

// recoverAgent wakes one agent of a lost terminal server, unless it was woken, archived or ended meanwhile.
func (h *SessionsHandler) recoverAgent(ctx context.Context, sid string) {
	ls, err := h.ss.GetLiveSession(ctx, sid)
	if err != nil || ls == nil || ls.IsSleeping != 1 || ls.IsArchived == 1 {
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

// ServerLostNotice is the fixed text of Coral's board notice to an agent it woke after the terminal server was lost.
const ServerLostNotice = "Coral's terminal server stopped and ended your terminal; Coral resumed you. Check your last step before you continue."
