package routes

import (
	"context"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
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

// needsYouKinds are the kinds an item can be (the keys of the answer's counts), the values ?kind= takes.
var needsYouKinds = map[string]bool{"agent": true, "question": true, "wait": true, "proposal": true, "review": true, "goal_done": true, "skill": true, "device_key": true}

// needsYouNotIncluded names what the Inbox counts that this read cannot see. A consumer must treat a word it does not know as informational (a later release may name more), never as an error: it means "this read does not cover that", not that the answer is invalid. A read that fails (refused, 404) is a different thing from an empty answer and must be shown as an incomplete list.
var needsYouNotIncluded = []string{"failed_runs", "welcome", "unrecorded_agents"}

// NeedsYouItem is one waiting thing: its kind (agent, question, wait, proposal, review), who it is from, one cleaned and cut line, the team, a stable id and when it began.
type NeedsYouItem struct {
	Kind string `json:"kind"`
	From string `json:"from,omitempty"`
	Line string `json:"line"`
	Team string `json:"team"`
	ID   string `json:"id"`
	At   string `json:"at"`
	// GoalID and TaskID: on a question, the goal and the task it is about (#12164), with their titles cleaned and cut; absent for none.
	GoalID    int64  `json:"goal_id,omitempty"`
	TaskID    int64  `json:"task_id,omitempty"`
	GoalTitle string `json:"goal_title,omitempty"`
	TaskTitle string `json:"task_title,omitempty"`
	// Section: where the redesigned Needs you page files the item (#22093): "permission" for an agent at a permission prompt (still kind agent), else "goal" when it has a GoalID, else "direct".
	Section string `json:"section,omitempty"`
	// NewComments: on a review item, how many replies agents left in the Operator's comment threads on the file since the Operator opened them (#12026). The file's row is unread again and counted once, as itself.
	NewComments int `json:"new_comments,omitempty"`
	// StillWaiting: on an agent item, the Operator dismissed this request but the agent is still waiting in its terminal (#14203): Dismiss marks it ignored, it does not resolve it, so the row stays, flagged,
	// until the agent's own evidence clears it.
	StillWaiting bool `json:"still_waiting,omitempty"`
	// Dialog and Options: on an agent item, the agent stands at a terminal dialog Coral read from its screen (#19864), and the numbers and labels of the menu's options as read, so a page that reads only this feed can draw them.
	// Words only (cleaned, secrets redacted, cut), at most needsYouOptionsMax: they are never a command, and what is pressed is answered by the agent's own answer-prompt, which re-reads the screen.
	Dialog  bool             `json:"dialog,omitempty"`
	Options []NeedsYouOption `json:"options,omitempty"`
	// Permission: on an agent item, the agent's own hooks say it waits on a permission prompt (#21256). Its Options, when there are any, are the prompt's one-time Yes and No only (permissionOptions),
	// read from the screen the dialog watch confirmed; a lasting grant is never offered, and a press is checked again on the Coral (needsYouPress).
	Permission bool `json:"permission,omitempty"`
	// Server: on an item a Hub read from one of its computers (#15380), the Hub's own id for that computer (never a name the computer chose); absent on this Coral's own items.
	Server string `json:"server,omitempty"`
}

// NeedsYouOption is one option of a dialog's menu: its number and its label.
type NeedsYouOption struct {
	N     int    `json:"n"`
	Label string `json:"label"`
}

const (
	needsYouOptionsMax     = 4
	needsYouOptionLabelMax = 60
)

// needsYouOptionLabel is a menu label as one clean line, secrets redacted, cut at needsYouOptionLabelMax characters.
func needsYouOptionLabel(s string) string {
	l := needsYouTitle(s)
	if r := []rune(l); len(r) > needsYouOptionLabelMax {
		return strings.TrimSpace(string(r[:needsYouOptionLabelMax-1])) + "…"
	}
	return l
}

// needsYouAnswer is the whole answer. Count is every waiting thing. The order of items is (time, id). The first read (no ?after=) gives the newest few, newest first, and the cursor is "<time>|<id>" of the newest item. A poll with ?after=<cursor> gives the items strictly after that place, OLDEST first, up to the limit, and the cursor becomes the last item given: a burst bigger than the limit, and items in one instant, are read in several polls, none skipped and none given twice (a poller reads until a poll is shorter than the limit). A bare time as the cursor is still taken, and includes the items at that time.
// instant are never lost).
type needsYouAnswer struct {
	Count       int               `json:"count"`
	Counts      map[string]int    `json:"counts"`
	Cursor      string            `json:"cursor"`
	Items       []NeedsYouItem    `json:"items"`
	NotIncluded []string          `json:"not_included"`
	Muted       map[string]int    `json:"muted,omitempty"`          // files the Operator's settings keep out of the count, by kind (#12144): never in Count, Counts or Items, never pushed
	Machines    []NeedsYouMachine `json:"machines,omitempty"`       // a Hub's merged read: the computers it covers and whether each was read (#15380)
	Unread      []string          `json:"unread_sources,omitempty"` // a source that could not be read this time: its things are missing from the count, not zero
	Groups      []NeedsYouGroup   `json:"groups,omitempty"`         // the groups of the whole list with the time of each one's newest item (#22093)
}

// NeedsYouGroup is one group of the Needs you page over the whole list, not the page of it: Key is "permission", "goal:<team>:<id>" or "direct"; NewestAt is the newest item's At.
type NeedsYouGroup struct {
	Key      string `json:"key"`
	Section  string `json:"section"`
	GoalID   int64  `json:"goal_id,omitempty"`
	Team     string `json:"team,omitempty"`
	Count    int    `json:"count"`
	NewestAt string `json:"newest_at"`
}

// needsYouSection is the section an item belongs to (#22093).
func needsYouSection(it NeedsYouItem) string {
	switch {
	case it.Kind == "agent" && it.Permission:
		return "permission"
	case it.GoalID > 0:
		return "goal"
	}
	return "direct"
}

// needsYouGroups sets every item's Section and returns the groups: permission prompts first, then by the newest item, newest first.
func needsYouGroups(items []NeedsYouItem) []NeedsYouGroup {
	idx := map[string]int{}
	var out []NeedsYouGroup
	for i := range items {
		it := &items[i]
		it.Section = needsYouSection(*it)
		g := NeedsYouGroup{Key: it.Section, Section: it.Section}
		if it.Section == "goal" {
			g.Key, g.GoalID, g.Team = "goal:"+it.Team+":"+strconv.FormatInt(it.GoalID, 10), it.GoalID, it.Team
			if it.Server != "" { // a Hub's merged read: the same team name and goal number on two computers are two groups
				g.Key = "goal:" + it.Server + "/" + it.Team + ":" + strconv.FormatInt(it.GoalID, 10)
			}
		}
		j, ok := idx[g.Key]
		if !ok {
			j = len(out)
			idx[g.Key] = j
			out = append(out, g)
		}
		out[j].Count++
		if it.At > out[j].NewestAt {
			out[j].NewestAt = it.At
		}
	}
	sort.SliceStable(out, func(a, b int) bool {
		if pa, pb := out[a].Section == "permission", out[b].Section == "permission"; pa != pb {
			return pa
		}
		return out[a].NewestAt > out[b].NewestAt
	})
	return out
}

// SetNeedsYouMemberFull tells the board how to list the live Full grants of Hub people, so the owner sees each one as long as it is live. Nil: none.
func (h *BoardHandler) SetNeedsYouMemberFull(fn func(ctx context.Context) ([]NeedsYouItem, error)) {
	h.needsYouMemberFull = fn
}

// SetNeedsYouSkills tells the board how to list the skills that wait for the Operator (the Skills Store owns them). Nil: none.
func (h *BoardHandler) SetNeedsYouSkills(fn func(ctx context.Context) ([]NeedsYouItem, error)) {
	h.needsYouSkills = fn
}

// SetNeedsYouDeviceKeys tells the board how to list the device keys a signed message added or raised lately, so the owner sees each new key by its fingerprint. Nil: none.
func (h *BoardHandler) SetNeedsYouDeviceKeys(fn func(ctx context.Context) ([]NeedsYouItem, error)) {
	h.needsYouDeviceKeys = fn
}

// SetAgentAsks tells the board how to list the open questions of single agents (#18106).
func (h *BoardHandler) SetAgentAsks(fn func(r *http.Request) []operatorAskRow) { h.agentAsks = fn }

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
	items := needsYouAgentItems(rows, time.Now())
	for i := range items {
		if items[i].Dialog || items[i].Permission {
			items[i].Options = needsYouMenu(items[i], h.dialogs.options(strings.TrimPrefix(items[i].ID, "agent:")))
		}
	}
	return items, nil
}

// needsYouAgentItems is the live list's rows reduced to the agents that wait on the Operator: awake, not archived, waiting for input (a request the Operator dismissed is still there while the agent waits, flagged StillWaiting, #14203). A row with no start time of its wait is given now (it is waiting now).
func needsYouAgentItems(rows []map[string]any, now time.Time) []NeedsYouItem {
	var out []NeedsYouItem
	for _, row := range rows {
		wait, _ := row["waiting_for_input"].(bool)
		dialogAt, dialog := dueDialogSince(row, now) // an agent at a terminal dialog the hook never reported (#19864)
		if !wait && !dialog {
			continue
		}
		if asleep, _ := row["sleeping"].(bool); asleep {
			continue
		}
		if gone, _ := row["archived"].(bool); gone {
			continue
		}
		if gone, _ := row["wait_removed"].(bool); gone {
			continue // the Operator removed this request from Needs you (#14266): out of the list and the count, though the agent still waits and its held messages stay held
		}
		hid, _ := row["wait_ignored"].(bool) // the Operator dismissed this request (#11946, #14203): the agent still waits in its terminal, so it stays, flagged, and the count, the page and the team page agree
		sid, _ := row["session_id"].(string)
		name, _ := row["display_name"].(string)
		if name == "" {
			name, _ = row["name"].(string)
		}
		line, _ := row["waiting_summary"].(string)
		at, _ := row["waiting_since"].(string)
		if !wait {
			line, at = DialogWords, dialogAt
		}
		if strings.TrimSpace(line) == "" {
			line = "Is waiting for you"
		}
		team, _ := row["board_project"].(string)
		if at = needsYouTime(at); at == "" {
			at = now.UTC().Format(time.RFC3339Nano)
		}
		kind, _ := row["waiting_kind"].(string)
		it := NeedsYouItem{Kind: "agent", From: needsYouLine(name), Line: needsYouLine(line), Team: team, ID: "agent:" + sid, At: at, StillWaiting: hid, Dialog: !wait, Permission: wait && kind == "permission"}
		if bt, _ := row["board_task"].(map[string]any); bt != nil && bt["status"] == "in_progress" { // the task the agent has claimed (#22093), not one that only waits in its queue
			if id, ok := bt["id"].(int64); ok {
				it.TaskID = id
			}
			if id, ok := bt["goal_id"].(int64); ok {
				it.GoalID = id
			}
			if t, ok := bt["title"].(string); ok {
				it.TaskTitle = needsYouLine(t)
			}
			if t, ok := bt["goal_title"].(string); ok {
				it.GoalTitle = needsYouLine(t)
			}
		}
		out = append(out, it)
	}
	return out
}

// needsYouMenu is what an agent item offers of the menu on its agent's screen: a permission prompt (the hooks say so) offers its one-time Yes and No only (#21256); any other
// dialog, a Yes/No about a folder or an update included, offers its menu as read (#19864).
func needsYouMenu(item NeedsYouItem, opts []NeedsYouOption) []NeedsYouOption {
	if item.Permission {
		return permissionOptions(opts)
	}
	if item.Dialog {
		return opts
	}
	return nil
}

// DialogWords is the line of an agent at a dialog, the dashboard's own words (at_dialog.js DIALOG_WORDS, #11430).
const DialogWords = "Needs one click: it is at a dialog"

// dueDialogSince: the row's agent stands at a dialog Coral read on its screen (at_dialog, #11437) that has stood for the minutes the row says, that the team wants to hear of and the Operator did not
// dismiss: the dashboard's dialogDue (at_dialog.js), so the dashboard, the phone push and a Hub list the same agents. It returns when the dialog began.
func dueDialogSince(row map[string]any, now time.Time) (string, bool) {
	d, _ := row["at_dialog"].(map[string]any)
	if d == nil {
		return "", false
	}
	if notify, ok := d["notify"].(bool); ok && !notify {
		return "", false
	}
	if gone, _ := d["dismissed"].(bool); gone {
		return "", false
	}
	since, _ := d["since"].(string)
	t, err := time.Parse(time.RFC3339Nano, since)
	if err != nil {
		return "", false
	}
	after := 5 // at_dialog.js DIALOG_AFTER_MIN, when the row does not say
	switch m := d["after_min"].(type) {
	case int:
		if m > 0 {
			after = m
		}
	case float64:
		if m > 0 {
			after = int(m)
		}
	}
	if now.Sub(t) < time.Duration(after)*time.Minute {
		return "", false
	}
	return t.UTC().Format(time.RFC3339Nano), true
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

	// ?kind=<kind> (#13834): only that kind's items are listed (count and counts stay the whole answer's, true), so a Hub's shell can read the skill rows without paging past newer questions. One of the kinds in counts; anything else is 400.
	kind := r.URL.Query().Get("kind")
	if kind != "" && !needsYouKinds[kind] {
		errBadRequest(w, "kind is one of agent, question, wait, proposal, review, goal_done, skill, device_key")
		return
	}
	items, unread, muted, err := h.needsYouItemsOf(r, kind == "skill") // ?kind=skill reads the skills only: count and counts then say what that read holds (#18623)
	if err != nil {
		errInternalServer(w, "could not read the boards")
		return
	}
	ans := needsYouAnswer{Count: len(items), Counts: map[string]int{"agent": 0, "question": 0, "wait": 0, "proposal": 0, "review": 0, "goal_done": 0, "skill": 0}, Items: []NeedsYouItem{}, NotIncluded: needsYouNotIncluded, Unread: unread}
	if len(muted) > 0 {
		ans.Muted = muted
	}
	for _, it := range items {
		ans.Counts[it.Kind]++
	}
	if kind != "" {
		kept := items[:0:0]
		for _, it := range items {
			if it.Kind == kind {
				kept = append(kept, it)
			}
		}
		items = kept
	}
	if h.needsYouRemotes != nil && !cur.set && realSession(r) { // a Hub's first page, for the owner's real sign-in session only (#15380)
		m := h.needsYouRemotes.mergedNeeds(r, kind)
		ans.Machines = m.Machines
		for k, v := range m.Counts {
			ans.Counts[k] += v
			ans.Count += v
		}
		items = append(items, m.Items...)
		if m.Failed {
			ans.NotIncluded = append(ans.NotIncluded, "unreachable_machines")
		}
	}
	ans.Groups = needsYouGroups(items) // over the whole list, before it is paged
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

// askWords are the words a short question uses: a message with one of them is a question, not a pointer to a file.
var askWords = regexp.MustCompile(`(?i)\b(approve|confirm|ok|okay|should|can|could|would|please|decide|choose|which|whether)\b`)

var needsYouFileLink = regexp.MustCompile(`(?i)coral://artifacts/([0-9a-f]{64})`)

// reviewLifecycleTags are the tags a file carries once it is in a review: waiting (for review), opened (read), kept (saved) or decided or replaced (approved, changes requested, denied, ignored, superseded).
var reviewLifecycleTags = []string{"for review", "read", "saved", "approved", "changes requested", "denied", "ignored", "superseded"}

// reviewedFileIDs is the artifact ids (lower case) of the files that have been in a review, whatever came of it.
func reviewedFileIDs(files []teamArtifact) map[string]bool {
	out := map[string]bool{}
	for _, f := range files {
		for _, t := range reviewLifecycleTags {
			if hasTag(f.Tags, t) {
				out[strings.ToLower(artifactStoreID(f))] = true
				break
			}
		}
	}
	return out
}

func allIn(ids []string, set map[string]bool) bool {
	for _, id := range ids {
		if !set[id] {
			return false
		}
	}
	return len(ids) > 0
}

// onlyFileLinks are the artifact ids a message is only links to: one or more coral://artifacts/<id> and at most a few words of its own (40 letters or digits), else nil (#11998, #12096: "design doc v5 is in your Inbox: coral://...").
func onlyFileLinks(text string) []string {
	m := needsYouFileLink.FindAllStringSubmatch(text, -1)
	if len(m) == 0 {
		return nil
	}
	rest := needsYouFileLink.ReplaceAllString(text, "")
	if strings.Contains(rest, "?") || askWords.MatchString(rest) {
		return nil // it asks something the file does not say ("Deploy to prod now? coral://..."): it stays a question (Security's SHOULD, #12096)
	}
	n := 0
	for _, r := range rest {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			n++
		}
	}
	if n > 40 {
		return nil
	}
	out := make([]string, len(m))
	for i := range m {
		out[i] = strings.ToLower(m[i][1])
	}
	return out
}

// needsYouItems is everything waiting for the Operator that the server can see, and the parts it could not read (unread). r is the person's own request:
// the agent rows are read as that person sees them. muted counts the files the Operator's settings keep out, by kind. An error is the boards themselves not reading.
func (h *BoardHandler) needsYouItems(r *http.Request) (items []NeedsYouItem, unread []string, muted map[string]int, err error) {
	return h.needsYouItemsOf(r, false)
}

// needsYouItemsOf is needsYouItems; onlySkills reads nothing but the skills that wait (#18623): the agent rows, every team's questions, waits, proposals, review files and finished goals are not read, as a Hub's
// shell reading ?kind=skill threw them away after the scans (0.1 to 0.6 s of the first dashboard load).
func (h *BoardHandler) needsYouItemsOf(r *http.Request, onlySkills bool) (items []NeedsYouItem, unread []string, muted map[string]int, err error) {
	ctx := r.Context()
	muted = map[string]int{}               // the files the Operator's settings mute, by kind: counted here and nowhere else (#12144)
	if h.agentAsks != nil && !onlySkills { // a single agent's question (#18106): kind question, no team
		for _, a := range h.agentAsks(r) {
			items = append(items, NeedsYouItem{Kind: "question", From: needsYouLine(a.Asker), Line: needsYouLine(a.Text), ID: "agent-ask:" + strconv.FormatInt(a.ID, 10), At: needsYouTime(a.At)})
		}
	}
	if h.needsYouAgents != nil && !onlySkills {
		if rows, err := h.needsYouAgents(r); err != nil {
			unread = append(unread, "agents")
		} else {
			items = append(items, rows...)
		}
	}
	var projects []board.ProjectInfo
	if !onlySkills {
		if projects, err = h.bs.ListProjects(ctx); err != nil {
			return nil, nil, nil, err
		}
	}
	now := time.Now().UTC()
	for _, p := range projects {
		if p.Archived {
			continue // a team that is put away asks nothing of anyone, its review files and questions included, until it is restored (#21850)
		}
		start, questionLinks, reviewFiles := len(items), map[int][]string{}, map[string]bool{} // a question that only links files the same team has in a review (for review, opened, decided, superseded) is those files, not a second item (#11998, #12096)
		h.keepExpiredOperatorQuestions(ctx, p.Project)                                         // a wait that ran out is an ask from now on (#11919)
		if asks, err := h.bs.OpenAsksOf(ctx, p.Project, board.OperatorName, now); err != nil {
			unread = appendOnce(unread, "questions")
		} else {
			askIDs := make([]int64, 0, len(asks))
			for _, a := range asks {
				askIDs = append(askIDs, a.MessageID)
			}
			subjects, links := h.askSubjects(ctx, p.Project, askIDs)
			withButtons, _ := h.bs.AskButtonsOf(ctx, p.Project, askIDs) // a question with answer buttons is never hidden: the Operator can only answer it from its row (Security's SHOULD, #12096)
			for _, a := range asks {
				sj := subjects[a.MessageID]
				if hexes := onlyFileLinks(a.Content); len(hexes) > 0 && len(withButtons[a.MessageID]) == 0 {
					questionLinks[len(items)] = hexes
				}
				items = append(items, NeedsYouItem{Kind: "question", From: needsYouLine(a.Asker), Line: needsYouLine(a.Content), Team: p.Project, ID: "question:" + p.Project + ":" + strconv.FormatInt(a.MessageID, 10), At: needsYouTime(a.At.UTC().Format(time.RFC3339Nano)),
					GoalID: sj.GoalID, TaskID: sj.TaskID, GoalTitle: needsYouLine(links.goalTitle(ctx, sj.GoalID)), TaskTitle: needsYouLine(links.taskTitle(ctx, sj.TaskID))})
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
			if len(questionLinks) > 0 {
				reviewFiles = reviewedFileIDs(files)
			}
			newVersion := h.newVersionUnopened(r, p.Project, files) // the person's own opened versions: a file read on an earlier version still waits while a newer one is unopened (#13959)
			for _, f := range files {
				if seen[f.ID] || !needsYouFileV(f.Tags, f.NewComments, newVersion[attentionKey(f.BoardID, artifactStoreID(f))]) {
					continue // by tags first: only a row that could count is checked against the stored file
				}
				if f.Muted {
					muted[kindOrFile(f.Kind)]++ // switched off by the Operator's settings (#12144): in its folder, not counted, not pushed
					continue
				}
				enrichTeamArtifact(&f, dir)
				if !f.Available {
					continue
				}
				seen[f.ID] = true
				items = append(items, NeedsYouItem{Kind: "review", Line: needsYouLine(f.Name), Team: p.Project, ID: "review:" + p.Project + ":" + f.ID, At: needsYouTime(f.CreatedAt), NewComments: f.NewComments})
			}
		}
		if len(questionLinks) > 0 { // drop the questions of this team that only link a file it lists as a file for review
			kept := items[:start]
			for i := start; i < len(items); i++ {
				if hexes, ok := questionLinks[i]; ok && allIn(hexes, reviewFiles) {
					continue
				}
				kept = append(kept, items[i])
			}
			items = kept
		}
	}

	if h.needsYouMemberFull != nil && !onlySkills { // a live Full grant of a Hub person (#20581 d)
		if rows, err := h.needsYouMemberFull(ctx); err != nil {
			unread = appendOnce(unread, "member_grants")
		} else {
			items = append(items, rows...)
		}
	}

	if h.needsYouSkills != nil { // the skills that wait for the Operator's approval (#12139)
		if rows, err := h.needsYouSkills(ctx); err != nil {
			unread = appendOnce(unread, "skills")
		} else {
			items = append(items, rows...)
		}
	}

	if h.needsYouDeviceKeys != nil && !onlySkills { // a device key a signed message added or raised (#20515 M4)
		if rows, err := h.needsYouDeviceKeys(ctx); err != nil {
			unread = appendOnce(unread, "device_keys")
		} else {
			items = append(items, rows...)
		}
	}

	var hiddenGoals, readGoals map[string]bool
	if !onlySkills {
		hiddenGoals, readGoals = h.goalDoneHiddenSet(ctx), h.goalDoneReadSet(ctx)
	}
	var goalNews map[string]int // replies agents left in the Operator's threads on a goal, unseen (#12073): the goal's item carries the count, and a read goal with news counts again
	if h.commentNews != nil && !onlySkills {
		goalNews, _ = h.commentNews(ctx)
	}
	for _, p := range projects {
		if p.Archived {
			continue
		}
		if gi, err := h.goalDoneItems(ctx, p.Project, hiddenGoals, readGoals, goalNews); err != nil {
			unread = appendOnce(unread, "goals")
		} else {
			items = append(items, gi...)
		}
	}

	return items, unread, muted, nil
}
