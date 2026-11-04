package routes

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
)

// Questions to the Operator in their Needs you (#11417). An agent asks the Operator in one of two ways: a post that @mentions them with --ask (an open question of the board), or a wait for their reply
// (coral-board wait --operator "question"). Neither was in the dashboard's Needs you, which is built from the live list, so the person did not see what they were asked. This route lists both, for every
// board, the whole question as text:
//
//	GET /api/operator-asks -> [{board, kind: "ask"|"wait", id, asker, text, cut, at}]
//	GET /api/operator-asks?paged=1[&limit=N][&cursor=C] -> {asks: [...], total, has_more, next_cursor}: newest first, 50 a page (1 to 200), every open question reachable (#13188)
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
	// BoardLabel is the team's name for a person to read (#11860: the panel said the internal board id); "" when the board has none, and the page then says the id.
	BoardLabel string `json:"board_label,omitempty"`
	Kind       string `json:"kind"`
	ID         int64  `json:"id"` // the question's message id (kind ask) or the wait's id (kind wait)
	Asker      string `json:"asker"`
	Text       string `json:"text"`
	Cut        bool   `json:"cut,omitempty"`
	At         string `json:"at"`
	// Buttons the asker declared on a question (#11643), in order, with their state (pending, used); the Operator's click claims one through the claim route.
	Buttons []board.AskButton `json:"buttons,omitempty"`
	// GoalID and TaskID are the goal and the task the question is about (#12164), checked to be of its team when it was posted, with their titles cleaned and cut; absent for none.
	GoalID    int64  `json:"goal_id,omitempty"`
	TaskID    int64  `json:"task_id,omitempty"`
	GoalTitle string `json:"goal_title,omitempty"`
	TaskTitle string `json:"task_title,omitempty"`
}

// OperatorAsks answers GET /api/operator-asks.
func (h *BoardHandler) OperatorAsks(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) {
		return
	}
	if refuseUnlessPerson(w, r, "read the questions asked of them") {
		return
	}
	paged, pagedLimit, pagedAfter, ok := operatorAsksPageParams(w, r)
	if !ok {
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
		h.keepExpiredOperatorQuestions(ctx, p.Project) // a wait that ran out is an ask from now on (#11919)
		asks, err := h.bs.OpenAsksOf(ctx, p.Project, "Operator", now)
		if err != nil {
			continue
		}
		ids := make([]int64, 0, len(asks))
		for _, a := range asks {
			ids = append(ids, a.MessageID)
		}
		withButtons, _ := h.bs.AskButtonsOf(ctx, p.Project, ids)
		subjects, links := h.askSubjects(ctx, p.Project, ids) // the goal and task each question is about (#12164)
		var reviewed map[string]bool                          // read once per team, and only when a message of it is only links to files (#12096)
		for _, a := range asks {
			if hexes := onlyFileLinks(a.Content); len(hexes) > 0 && len(withButtons[a.MessageID]) == 0 { // a question with answer buttons is never hidden (Security's SHOULD)
				if reviewed == nil {
					reviewed = map[string]bool{}
					if files, _, ferr := h.projectArtifactItems(r, p.Project, ""); ferr == nil {
						reviewed = reviewedFileIDs(files)
					}
				}
				if allIn(hexes, reviewed) {
					continue // "design doc v5 is in your Inbox: coral://...": the file is the item; once opened, decided or replaced the message is read
				}
			}
			text, cut := operatorAskText(a.Content)
			rows = append(rows, operatorAskRow{Board: p.Project, BoardLabel: clitext.CleanName(p.BoardLabel), Kind: "ask", ID: a.MessageID, Asker: clitext.CleanName(a.Asker), Text: text, Cut: cut, At: a.At.UTC().Format(time.RFC3339), Buttons: withButtons[a.MessageID],
				GoalID: subjects[a.MessageID].GoalID, TaskID: subjects[a.MessageID].TaskID, GoalTitle: links.goalTitle(ctx, subjects[a.MessageID].GoalID), TaskTitle: links.taskTitle(ctx, subjects[a.MessageID].TaskID)})
		}
		waits, err := h.bs.ListOperatorQuestions(ctx, p.Project)
		if err != nil {
			continue
		}
		for _, q := range waits {
			text, cut := operatorAskText(q.Reason)
			rows = append(rows, operatorAskRow{Board: p.Project, BoardLabel: clitext.CleanName(p.BoardLabel), Kind: "wait", ID: q.ID, Asker: clitext.CleanName(q.SubscriberID), Text: text, Cut: cut, At: q.CreatedAt})
		}
	}
	if paged { // ?paged=1 (#13188): newest first, every open question reachable by next_cursor, the true total
		writeJSON(w, http.StatusOK, pageOperatorAsks(rows, pagedLimit, pagedAfter))
		return
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

// operatorAsksPageParams reads ?paged=1[&limit=N][&cursor=C] (#13188). Without paged the answer stays the bare array it was (coral-hub parses it so), and limit and cursor are ignored as they were.
func operatorAsksPageParams(w http.ResponseWriter, r *http.Request) (paged bool, limit int, after *operatorAskPos, ok bool) {
	q := r.URL.Query()
	if !q.Has("paged") {
		return false, 0, nil, true // as before: any other parameter is ignored
	}
	if q.Get("paged") != "1" || len(q["paged"]) != 1 {
		errBadRequest(w, "paged must be 1")
		return false, 0, nil, false
	}
	limit = 50
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 200 {
			errBadRequest(w, "limit must be 1 to 200")
			return false, 0, nil, false
		}
		limit = n
	}
	if c := q.Get("cursor"); c != "" {
		pos, good := decodeOperatorAskPos(c)
		if !good {
			errBadRequest(w, "invalid cursor")
			return false, 0, nil, false
		}
		after = &pos
	}
	return true, limit, after, true
}

// operatorAskPos is a place in the newest-first list: the last row sent.
type operatorAskPos struct {
	At    string `json:"a"`
	Board string `json:"b"`
	Kind  string `json:"k"`
	ID    int64  `json:"i"`
}

func decodeOperatorAskPos(c string) (operatorAskPos, bool) {
	var p operatorAskPos
	if len(c) > 1024 {
		return p, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(c)
	if err != nil || json.Unmarshal(raw, &p) != nil || p.At == "" || p.ID <= 0 {
		return p, false
	}
	return p, true
}

// askBefore is the newest-first order: later time first, then board, kind and id, so no two rows tie.
func askBefore(a, b operatorAskRow) bool {
	if a.At != b.At {
		return a.At > b.At
	}
	if a.Board != b.Board {
		return a.Board < b.Board
	}
	if a.Kind != b.Kind {
		return a.Kind < b.Kind
	}
	return a.ID < b.ID
}

// pageOperatorAsks answers one page of the open questions: newest first, at most limit past the cursor's place, with the true total and next_cursor when there is more.
func pageOperatorAsks(rows []operatorAskRow, limit int, after *operatorAskPos) map[string]any {
	sort.SliceStable(rows, func(i, j int) bool { return askBefore(rows[i], rows[j]) })
	start := 0
	if after != nil {
		at := operatorAskRow{At: after.At, Board: after.Board, Kind: after.Kind, ID: after.ID}
		start = sort.Search(len(rows), func(i int) bool { return askBefore(at, rows[i]) }) // the first row after the place
	}
	end := start + limit
	out := map[string]any{"asks": []operatorAskRow{}, "total": len(rows), "has_more": false}
	if end < len(rows) {
		last := rows[end-1]
		raw, _ := json.Marshal(operatorAskPos{At: last.At, Board: last.Board, Kind: last.Kind, ID: last.ID})
		out["has_more"] = true
		out["next_cursor"] = base64.RawURLEncoding.EncodeToString(raw)
	} else {
		end = len(rows)
	}
	if start < end {
		out["asks"] = rows[start:end]
	}
	return out
}
