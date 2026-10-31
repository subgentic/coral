package routes

import (
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/clitext"
)

// Questions to the Operator in their Needs you (#11417). An agent asks the Operator in one of two ways: a post that @mentions them with --ask (an open question of the board), or a wait for their reply
// (coral-board wait --operator "question"). Neither was in the dashboard's Needs you, which is built from the live list, so the person did not see what they were asked. This route lists both, for every
// board, the whole question as text:
//
//	GET /api/operator-asks -> [{board, kind: "ask"|"wait", id, asker, text, cut, at}]
//
// The reply is the board post the dashboard already makes (POST /api/board/{board}/messages with reply_to and the asker's @name): a reply to an ask answers it, and any post of the Operator's ends a wait. So
// this route only reads. It is the Operator's alone: a person's own dashboard or signed command line, never an agent's token or a script; through Coral Hub the owner's alone.

const (
	// operatorAskTextMax is the most of one question the row carries; a longer one says it was cut.
	operatorAskTextMax = 4096
	// operatorAsksMax bounds the list.
	operatorAsksMax = 200
)

type operatorAskRow struct {
	Board string `json:"board"`
	Kind  string `json:"kind"`
	ID    int64  `json:"id"` // the question's message id (kind ask) or the wait's id (kind wait)
	Asker string `json:"asker"`
	Text  string `json:"text"`
	Cut   bool   `json:"cut,omitempty"`
	At    string `json:"at"`
}

// OperatorAsks answers GET /api/operator-asks.
func (h *BoardHandler) OperatorAsks(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) {
		return
	}
	if refuseUnlessPerson(w, r, "read the questions asked of them") {
		return
	}
	ctx := r.Context()
	projects, err := h.bs.ListProjects(ctx)
	if err != nil {
		errInternalServer(w, "could not read the boards")
		return
	}
	now := time.Now().UTC()
	rows := []operatorAskRow{}
	for _, p := range projects {
		asks, err := h.bs.OpenAsksOf(ctx, p.Project, "Operator", now)
		if err != nil {
			continue
		}
		for _, a := range asks {
			text, cut := operatorAskText(a.Content)
			rows = append(rows, operatorAskRow{Board: p.Project, Kind: "ask", ID: a.MessageID, Asker: clitext.CleanName(a.Asker), Text: text, Cut: cut, At: a.At.UTC().Format(time.RFC3339)})
		}
		waits, err := h.bs.ListOperatorQuestions(ctx, p.Project)
		if err != nil {
			continue
		}
		for _, q := range waits {
			text, cut := operatorAskText(q.Reason)
			rows = append(rows, operatorAskRow{Board: p.Project, Kind: "wait", ID: q.ID, Asker: clitext.CleanName(q.SubscriberID), Text: text, Cut: cut, At: q.CreatedAt})
		}
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].At < rows[j].At })
	if len(rows) > operatorAsksMax {
		rows = rows[len(rows)-operatorAsksMax:]
	}
	writeJSON(w, http.StatusOK, rows)
}

// operatorAskText is a question as the row shows it: cleaned (clitext.Clean), valid UTF-8, at most operatorAskTextMax bytes, and whether it was cut.
func operatorAskText(s string) (string, bool) {
	s = strings.TrimSpace(clitext.Clean(s))
	if len(s) <= operatorAskTextMax {
		return s, false
	}
	s = s[:operatorAskTextMax]
	for !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s, true
}
