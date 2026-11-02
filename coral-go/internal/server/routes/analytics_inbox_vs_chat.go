package routes

import (
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// GET /api/analytics/inbox-vs-chat?days=&team= (#12158, the Operator's Analytics tab): how much of what the Operator did they did in the Inbox and how much in a chat or terminal. COUNTS ONLY: day buckets, kinds,
// team ids and numbers, no text, no length and no id (board.InboxVsChat says what each number is). The Operator's alone and read only, on this computer: not in the agent census, history search or the feed.
// `days` defaults to 28 and is cut to 90 (the touches are kept 90 days); `team` is a board id.

// InboxVsChatHandler serves the read.
type InboxVsChatHandler struct {
	bs  *board.Store
	ss  *store.SessionStore // the Operator's comment counts (their own database)
	now func() time.Time
}

// NewInboxVsChatHandler creates the handler.
func NewInboxVsChatHandler(bs *board.Store, ss *store.SessionStore) *InboxVsChatHandler {
	return &InboxVsChatHandler{bs: bs, ss: ss}
}

func (h *InboxVsChatHandler) clock() time.Time {
	if h.now != nil {
		return h.now().UTC()
	}
	return time.Now().UTC()
}

// Read answers the read.
func (h *InboxVsChatHandler) Read(w http.ResponseWriter, r *http.Request) {
	if cloud.Tunneled(r) || r.Header.Get(tunnel.ViaHeader) != "" {
		commentRefuse(w, http.StatusForbidden, "not_through_hub", "the Inbox-versus-chat counts are on this computer only")
		return
	}
	if !operatorOnly(w, r) {
		return
	}
	q := r.URL.Query()
	team := q.Get("team")
	if team != "" && !commentBoardRe.MatchString(team) {
		errBadRequest(w, "invalid team")
		return
	}
	days := 28
	if v := q.Get("days"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			errBadRequest(w, "days is a positive number")
			return
		}
		days = n
	}
	if days > board.MaxActivityDays {
		days = board.MaxActivityDays
	}
	now := h.clock()
	until := now.Truncate(24 * time.Hour).Add(24 * time.Hour) // the end of today, UTC: today's day bucket is whole
	since := until.Add(-time.Duration(days) * 24 * time.Hour)
	res, err := h.bs.InboxVsChatCounts(r.Context(), team, since.Format(time.RFC3339), until.Format(time.RFC3339))
	if err != nil {
		slog.Error("inbox vs chat read failed", "error", err) // the detail is the log's: a reply never carries a store's error text
		errInternalServer(w, "the read failed")
		return
	}
	if h.ss != nil { // a part that cannot be read is left out: the comments are one kind among the Inbox's
		if cs, err := h.ss.OwnerCommentCounts(r.Context(), since.Format(time.RFC3339), until.Format(time.RFC3339), team); err != nil {
			slog.Error("inbox vs chat comment counts failed", "error", err)
		} else {
			for _, c := range cs {
				res.AddComments(c.Day, c.Board, c.N)
			}
			sort.Slice(res.Teams, func(i, j int) bool {
				a, b := res.Teams[i], res.Teams[j]
				if a.Inbox+a.Chat != b.Inbox+b.Chat {
					return a.Inbox+a.Chat > b.Inbox+b.Chat
				}
				return a.Team < b.Team
			})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"days_asked": days, "generated_at": now.Format(time.RFC3339), "counts": res})
}
