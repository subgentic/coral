package routes

import (
	"context"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
)

// GET /api/needs-you?after=<cursor>&limit=<n> (#11596): what is waiting for the Operator, in one read, for the Hub's phone push. It is the Inbox's Needs you as the SERVER can know it: agents waiting on a permission, a question or a
// plan; questions agents asked the Operator (post --ask, wait --operator); goal and task proposals waiting for a decision; and files for review the Operator has not opened. The count is what the Inbox counts for
// those four; what only the browser knows (failed runs not yet dismissed, the welcome items, an unrecorded-agents row) is not here, and the answer says so in "not_included". An ignored, saved or denied file, a read
// file, and an agent that sleeps are not waiting, so they are not counted. The Operator's alone: on this computer a person, through Coral Hub the owner (an owner row, at the View tier like the lists it reads).
// Every line is agent-written text, cleaned and cut here (needsYouLineMax), never raw.

const (
	needsYouLineMax      = 140
	needsYouItemsDefault = 20
	needsYouItemsMax     = 50
)

// needsYouNotIncluded names what the Inbox counts that this read cannot see.
var needsYouNotIncluded = []string{"failed_runs", "welcome", "unrecorded_agents"}

// NeedsYouItem is one waiting thing: its kind (agent, question, wait, proposal, review), who it is from, one cleaned and cut line, the team, a stable id and when it began.
type NeedsYouItem struct {
	Kind string `json:"kind"`
	From string `json:"from,omitempty"`
	Line string `json:"line"`
	Team string `json:"team"`
	ID   string `json:"id"`
	At   string `json:"at"`
}

// needsYouAnswer is the whole answer. Count is every waiting thing. The order of items is (time, id). The first read (no ?after=) gives the newest few, newest first, and the cursor is "<time>|<id>" of the newest item. A poll with ?after=<cursor> gives the items strictly after that place, OLDEST first, up to the limit, and the cursor becomes the last item given: a burst bigger than the limit, and items in one instant, are read in several polls, none skipped and none given twice (a poller reads until a poll is shorter than the limit). A bare time as the cursor is still taken, and includes the items at that time.
// instant are never lost).
type needsYouAnswer struct {
	Count       int            `json:"count"`
	Counts      map[string]int `json:"counts"`
	Cursor      string         `json:"cursor"`
	Items       []NeedsYouItem `json:"items"`
	NotIncluded []string       `json:"not_included"`
	Unread      []string       `json:"unread_sources,omitempty"` // a source that could not be read this time: its things are missing from the count, not zero
}

// SetNeedsYouSkills tells the board how to list the skills that wait for the Operator (the Skills Store owns them). Nil: none.
func (h *BoardHandler) SetNeedsYouSkills(fn func(ctx context.Context) ([]NeedsYouItem, error)) {
	h.needsYouSkills = fn
}

// SetNeedsYouAgents tells the board how to list the agents waiting on the Operator (the live list's rows; the sessions handler owns them).
func (h *BoardHandler) SetNeedsYouAgents(fn func(r *http.Request) ([]NeedsYouItem, error)) {
	h.needsYouAgents = fn
}

// NeedsYouAgents is the agents waiting on the Operator: the live list's awake rows that wait for input, with the line the Inbox draws.
func (h *SessionsHandler) NeedsYouAgents(r *http.Request) ([]NeedsYouItem, error) {
	rows, err := h.liveSessionRows(r, newPhaseTrace("needs-you"), true)
	if err != nil {
		return nil, err
	}
	return needsYouAgentItems(rows, time.Now()), nil
}

// needsYouAgentItems is the live list's rows reduced to the agents that wait on the Operator: awake, not archived, waiting for input. A row with no start time of its wait is given now (it is waiting now).
func needsYouAgentItems(rows []map[string]any, now time.Time) []NeedsYouItem {
	var out []NeedsYouItem
	for _, row := range rows {
		if wait, _ := row["waiting_for_input"].(bool); !wait {
			continue
		}
		if asleep, _ := row["sleeping"].(bool); asleep {
			continue
		}
		if gone, _ := row["archived"].(bool); gone {
			continue
		}
		sid, _ := row["session_id"].(string)
		name, _ := row["display_name"].(string)
		if name == "" {
			name, _ = row["name"].(string)
		}
		line, _ := row["waiting_summary"].(string)
		if strings.TrimSpace(line) == "" {
			line = "Is waiting for you"
		}
		team, _ := row["board_project"].(string)
		at, _ := row["waiting_since"].(string)
		if at = needsYouTime(at); at == "" {
			at = now.UTC().Format(time.RFC3339Nano)
		}
		out = append(out, NeedsYouItem{Kind: "agent", From: needsYouLine(name), Line: needsYouLine(line), Team: team, ID: "agent:" + sid, At: at})
	}
	return out
}

// needsYouWithheld stands in for a line when the secrets redactor is unavailable.
const needsYouWithheld = "(text withheld)"

// needsYouLine is agent text as one line: secrets redacted, cleaned, white space collapsed, cut at needsYouLineMax characters.
func needsYouLine(s string) string {
	red, ok := redactComment(s) // secrets out BEFORE the cut: a cut can walk a token's boundary; with no redactor nothing is sent (Security's SHOULD on #11596)
	if !ok {
		return needsYouWithheld
	}
	s = strings.Join(strings.Fields(clitext.Clean(red)), " ")
	if utf8.RuneCountInString(s) <= needsYouLineMax {
		return s
	}
	r := []rune(s)
	return strings.TrimSpace(string(r[:needsYouLineMax-1])) + "…"
}

// needsYouTime is a time as RFC3339 in UTC, or "" when it does not read.
func needsYouTime(s string) string {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.UTC().Format(time.RFC3339Nano)
	}
	return ""
}

// NeedsYou answers GET /api/needs-you?after=<cursor>&limit=<n>.
func (h *BoardHandler) NeedsYou(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) {
		return
	}
	if refuseUnlessPerson(w, r, "read what is waiting for them") {
		return
	}
	ctx := r.Context()
	cur, ok := parseNeedsYouCursor(r.URL.Query().Get("after"))
	if !ok {
		errBadRequest(w, "after is a cursor from an earlier answer")
		return
	}
	limit := needsYouItemsDefault
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			errBadRequest(w, "limit is a number from 1 to "+strconv.Itoa(needsYouItemsMax))
			return
		}
		limit = min(n, needsYouItemsMax)
	}

	var items []NeedsYouItem
	var unread []string
	if h.needsYouAgents != nil {
		if rows, err := h.needsYouAgents(r); err != nil {
			unread = append(unread, "agents")
		} else {
			items = append(items, rows...)
		}
	}
	projects, err := h.bs.ListProjects(ctx)
	if err != nil {
		errInternalServer(w, "could not read the boards")
		return
	}
	now := time.Now().UTC()
	for _, p := range projects {
		h.keepExpiredOperatorQuestions(ctx, p.Project) // a wait that ran out is an ask from now on (#11919)
		if asks, err := h.bs.OpenAsksOf(ctx, p.Project, board.OperatorName, now); err != nil {
			unread = appendOnce(unread, "questions")
		} else {
			for _, a := range asks {
				items = append(items, NeedsYouItem{Kind: "question", From: needsYouLine(a.Asker), Line: needsYouLine(a.Content), Team: p.Project, ID: "question:" + p.Project + ":" + strconv.FormatInt(a.MessageID, 10), At: needsYouTime(a.At.UTC().Format(time.RFC3339Nano))})
			}
		}
		if waits, err := h.bs.ListOperatorQuestions(ctx, p.Project); err != nil {
			unread = appendOnce(unread, "questions")
		} else {
			for _, q := range waits {
				items = append(items, NeedsYouItem{Kind: "wait", From: needsYouLine(q.SubscriberID), Line: needsYouLine(q.Reason), Team: p.Project, ID: "wait:" + p.Project + ":" + strconv.FormatInt(q.ID, 10), At: needsYouTime(q.CreatedAt)})
			}
		}
		if props, err := h.bs.ListProposals(ctx, p.Project, board.ProposalPending); err != nil {
			unread = appendOnce(unread, "proposals")
		} else {
			for _, pr := range props {
				items = append(items, NeedsYouItem{Kind: "proposal", From: needsYouLine(pr.Proposer), Line: needsYouLine(pr.Title), Team: p.Project, ID: "proposal:" + p.Project + ":" + strconv.FormatInt(pr.ID, 10), At: needsYouTime(pr.CreatedAt)})
			}
		}
		if files, _, err := h.projectArtifactItems(r, p.Project, ""); err != nil {
			unread = appendOnce(unread, "reviews")
		} else {
			seen := map[string]bool{}
			dir := h.artifactObjectDir()
			for _, f := range files {
				if seen[f.ID] || !hasTag(f.Tags, "for review") || hasTag(f.Tags, "read") || hasTag(f.Tags, "saved") {
					continue // by tags first: only a row that could count is checked against the stored file
				}
				enrichTeamArtifact(&f, dir)
				if !f.Available {
					continue
				}
				seen[f.ID] = true
				items = append(items, NeedsYouItem{Kind: "review", Line: needsYouLine(f.Name), Team: p.Project, ID: "review:" + p.Project + ":" + f.ID, At: needsYouTime(f.CreatedAt)})
			}
		}
	}

	if h.needsYouSkills != nil { // the skills that wait for the Operator's approval (#12139)
		if rows, err := h.needsYouSkills(ctx); err != nil {
			unread = appendOnce(unread, "skills")
		} else {
			items = append(items, rows...)
		}
	}

	hiddenGoals := h.goalDoneHiddenSet(ctx)
	for _, p := range projects {
		if gi, err := h.goalDoneItems(ctx, p.Project, hiddenGoals); err != nil {
			unread = appendOnce(unread, "goals")
		} else {
			items = append(items, gi...)
		}
	}

	ans := needsYouAnswer{Count: len(items), Counts: map[string]int{"agent": 0, "question": 0, "wait": 0, "proposal": 0, "review": 0, "goal_done": 0, "skill": 0}, Items: []NeedsYouItem{}, NotIncluded: needsYouNotIncluded, Unread: unread}
	for _, it := range items {
		ans.Counts[it.Kind]++
	}
	// the order is (time, id): items recorded to the same second are told apart by id, so a cursor is a place in a total order
	sort.SliceStable(items, func(i, j int) bool { return needsYouBefore(items[i], items[j]) })
	if !cur.set {
		// the first read: the newest few, newest first, and the cursor is the newest item's place (what was older is the baseline the poller starts from)
		if len(items) > 0 {
			ans.Cursor = needsYouCursorOf(items[len(items)-1])
		}
		for i := len(items) - 1; i >= 0 && len(ans.Items) < limit; i-- {
			ans.Items = append(ans.Items, items[i])
		}
	} else {
		// a poll: what is strictly after the cursor's place, OLDEST first, up to the limit, and the cursor moves to the last item given, so a burst bigger than the limit, and items in one instant, are read
		// in several polls and none is skipped or given twice. A bare time (the first form of the cursor) is still taken, and includes the items at that time.
		ans.Cursor = cur.raw
		for _, it := range items {
			if len(ans.Items) == limit {
				break
			}
			if !cur.before(it) {
				continue
			}
			ans.Items = append(ans.Items, it)
			ans.Cursor = needsYouCursorOf(it)
		}
	}
	writeJSON(w, http.StatusOK, ans)
}

func appendOnce(list []string, s string) []string {
	for _, x := range list {
		if x == s {
			return list
		}
	}
	return append(list, s)
}

// needsYouCursor is a place in the answer's order: a time, and (once an item has been given) that item's id.
type needsYouCursor struct {
	set   bool
	raw   string
	at    time.Time
	id    string
	hasID bool
}

// parseNeedsYouCursor reads ?after=: empty is no cursor; "<RFC3339 time>|<id>" is the place of an item; a bare time is accepted as before.
func parseNeedsYouCursor(v string) (needsYouCursor, bool) {
	if v == "" {
		return needsYouCursor{}, true
	}
	c := needsYouCursor{set: true, raw: v}
	timePart, id, hasID := strings.Cut(v, "|")
	t, err := time.Parse(time.RFC3339Nano, timePart)
	if err != nil || (hasID && id == "") {
		return needsYouCursor{}, false
	}
	c.at, c.id, c.hasID = t, id, hasID
	return c, true
}

// before reports whether the item comes strictly after the cursor's place (a bare time: at or after it).
func (c needsYouCursor) before(it NeedsYouItem) bool {
	t, err := time.Parse(time.RFC3339Nano, it.At)
	if err != nil {
		return false
	}
	if t.After(c.at) {
		return true
	}
	if !t.Equal(c.at) {
		return false
	}
	if !c.hasID {
		return true
	}
	return it.ID > c.id
}

// needsYouBefore orders two items by time, then id.
func needsYouBefore(a, b NeedsYouItem) bool {
	ta, ea := time.Parse(time.RFC3339Nano, a.At)
	tb, eb := time.Parse(time.RFC3339Nano, b.At)
	if ea != nil || eb != nil { // an item with no readable time sorts first, by id
		if (ea != nil) != (eb != nil) {
			return ea != nil
		}
		return a.ID < b.ID
	}
	if !ta.Equal(tb) {
		return ta.Before(tb)
	}
	return a.ID < b.ID
}

// needsYouCursorOf is the cursor that points at an item: its time and its id.
func needsYouCursorOf(it NeedsYouItem) string { return it.At + "|" + it.ID }
