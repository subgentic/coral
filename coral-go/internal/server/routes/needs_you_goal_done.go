package routes

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
	setreg "github.com/subgentic/coral/internal/settings"
)

// goalDoneHiddenMax is how many entries of the saved goal_done_hidden list are read: the newest ones the page keeps (it keeps 100).
const goalDoneHiddenMax = 200

// SetGoalDoneHidden tells the board where to read the goals the Operator hid from Needs you (setting goal_done_hidden, #11825): each entry is "<team>|<goal id>|<tasks the goal had>" (Not yet: hides the goal
// until a task is added) or "<team>|<goal id>|*" (Ignore). nil: nothing is hidden.
func (h *BoardHandler) SetGoalDoneHidden(fn func(ctx context.Context) []string) {
	h.goalDoneHidden = fn
}

// SetGoalDoneRead tells the board where to read the goals the Operator opened in Needs you (setting goal_done_read, #11983): each entry is "<team>|<goal id>|<tasks the goal had>|<the goal's updated_at>" (goalDoneReadKey). An opened goal is listed on the
// page and not counted, as a read file is: it is not an item here, so the count, the tab badge, the phone push and this read say one number. nil: none is read.
func (h *BoardHandler) SetGoalDoneRead(fn func(ctx context.Context) []string) {
	h.goalDoneRead = fn
}

// GoalDoneHiddenFrom reads the list out of the saved settings: a JSON array of strings, at most goalDoneHiddenMax of them; anything else is an empty list.
func GoalDoneHiddenFrom(st map[string]string) []string {
	return goalDoneListFrom(st, setreg.GoalDoneHidden)
}

// GoalDoneReadFrom reads the goal_done_read list the same way.
func GoalDoneReadFrom(st map[string]string) []string {
	return goalDoneListFrom(st, setreg.GoalDoneRead)
}

func goalDoneListFrom(st map[string]string, key string) []string {
	var list []string
	if err := json.Unmarshal([]byte(setreg.Text(st, key)), &list); err != nil {
		return nil
	}
	if len(list) > goalDoneHiddenMax {
		list = list[len(list)-goalDoneHiddenMax:]
	}
	return list
}

// goalDoneQuiet is how long a goal whose tasks are all done waits before it is the Operator's "Goal looks done" item (#12161): the Operator's "perhaps just a 15 minute period after the most recent task is completed,
// before sending it to my inbox". A goal whose exploration is done but whose next tasks are not filed yet is the driver's for those minutes; a task added in them cancels the item.
const goalDoneQuiet = 15 * time.Minute

// goalDoneQuietOver says the goal's latest task completion (looks_done_at, board.Goal.LooksDoneAt) is at least goalDoneQuiet old at now. A goal with no completion time (a read that has none) is not held back.
func goalDoneQuietOver(g board.Goal, now time.Time, quiet time.Duration) bool {
	if g.LooksDoneAt == nil || *g.LooksDoneAt == "" {
		return true
	}
	at, err := time.Parse(time.RFC3339Nano, *g.LooksDoneAt)
	if err != nil {
		return true
	}
	return now.Sub(at) >= quiet
}

// goalDoneKey is the entry Not yet writes for a goal at its all-done total.
func goalDoneKey(team string, id int64, total int) string {
	return team + "|" + strconv.FormatInt(id, 10) + "|" + strconv.Itoa(total)
}

// goalDoneReadKey is the entry the page writes when the Operator opens a goal's item: the all-done total and the goal's last change (updated_at, which a close, a reopen or an edit moves) it was opened at, so a goal
// finished again after a reopen, with the same total, is unread again (#12006).
func goalDoneReadKey(team string, id int64, total int, updatedAt string) string {
	return goalDoneKey(team, id, total) + "|" + updatedAt
}

// goalDoneItems is the board's active goals whose tasks are all done (at least one task, none open, the state exactly active: the rule the goal screen's all-done box used), as items of Needs you, less the
// ones the Operator hid. One item per goal; a goal that closes, gets a task, or is blocked is no longer one.
func (h *BoardHandler) goalDoneItems(ctx context.Context, project string, hidden, read map[string]bool, news map[string]int) ([]NeedsYouItem, error) {
	quiet := h.goalDoneQuietFor(ctx)
	driven := h.goalDoneDriven(ctx, project)
	var items []NeedsYouItem
	cursor := ""
	for {
		page, err := h.bs.GoalPage(ctx, project, board.GoalListQuery{States: []string{board.GoalActive}, Limit: 100, Cursor: cursor})
		if err != nil {
			return nil, err
		}
		for _, g := range page.Goals {
			r := g.Rollup
			if g.State != board.GoalActive || r.Total == 0 || r.Done != r.Total || g.MovedOpen > 0 || !goalDoneQuietOver(g, h.goalDoneClock()(), quiet) {
				continue
			}
			if hidden[goalDoneKey(project, g.ID, r.Total)] || hidden[project+"|"+strconv.FormatInt(g.ID, 10)+"|*"] {
				continue
			}
			if read[goalDoneReadKey(project, g.ID, r.Total, g.UpdatedAt)] && news[goalSubject(project, g.ID)] == 0 { // a read goal counts again while agents have replied in the Operator's thread on it and they have not opened it (#12073)
				continue // opened at this total and last change: read, not counted (a task done since has a new total, a goal reopened or edited a new last change, and the item is back)
			}
			if driven.skips(g) { // #21442: a goal with a driver, or one that was an item once, is not put in front of the Operator again
				continue
			}
			driven.record(ctx, h, g)
			items = append(items, NeedsYouItem{Kind: "goal_done", Line: needsYouLine("Goal #" + strconv.FormatInt(g.ID, 10) + " looks done: " + g.Title), Team: project, ID: "goal_done:" + project + ":" + strconv.FormatInt(g.ID, 10), At: needsYouTime(goalDoneArrival(g, quiet)), NewComments: news[goalSubject(project, g.ID)]})
		}
		if page.NextCursor == "" {
			return items, nil
		}
		cursor = page.NextCursor
	}
}

// SetGoalDoneQuiet tells the board where to read the quiet period (setting goal_done_quiet_minutes, #12161). nil: goalDoneQuiet (15 minutes).
func (h *BoardHandler) SetGoalDoneQuiet(fn func(ctx context.Context) time.Duration) {
	h.goalDoneQuietFn = fn
}

// GoalDoneQuietFrom reads the period out of the saved settings: minutes, 0 to 1440, 15 when unset or unreadable.
func GoalDoneQuietFrom(st map[string]string) time.Duration {
	return time.Duration(setreg.Int(st, setreg.GoalDoneQuietMinutes)) * time.Minute
}

func (h *BoardHandler) goalDoneQuietFor(ctx context.Context) time.Duration {
	if h.goalDoneQuietFn != nil {
		return h.goalDoneQuietFn(ctx)
	}
	return goalDoneQuiet
}

// goalDoneClock is the handler's clock for the quiet period.
func (h *BoardHandler) goalDoneClock() func() time.Time {
	if h.goalDoneNow != nil {
		return h.goalDoneNow
	}
	return time.Now
}

// goalDoneHiddenSet is the saved list as a set, read on every request.
func (h *BoardHandler) goalDoneHiddenSet(ctx context.Context) map[string]bool {
	return listSet(ctx, h.goalDoneHidden)
}

// goalDoneReadSet is the goal_done_read list as a set, read on every request.
func (h *BoardHandler) goalDoneReadSet(ctx context.Context) map[string]bool {
	return listSet(ctx, h.goalDoneRead)
}

func listSet(ctx context.Context, fn func(ctx context.Context) []string) map[string]bool {
	set := map[string]bool{}
	if fn == nil {
		return set
	}
	for _, e := range fn(ctx) {
		set[e] = true
	}
	return set
}

// The inbox wait starts when the quiet period ends, not at goal creation or an old task completion.
func goalDoneArrival(g board.Goal, quiet time.Duration) string {
	if g.LooksDoneAt != nil {
		if at, err := time.Parse(time.RFC3339, *g.LooksDoneAt); err == nil {
			return at.Add(quiet).UTC().Format(time.RFC3339)
		}
	}
	return g.UpdatedAt
}

// goalDoneDrivenState is what #21442 reads once for a board: whether the setting brings back the items of driven goals, who could drive a goal (the active members and the Orchestrator), and the goals already shown once.
type goalDoneDrivenState struct {
	showAll bool
	active  []board.Subscriber
	orch    string
	shown   []string // entries "team|goal|looks-done time": the goals that were an item
	known   bool     // the lists were read; when not, nothing is held back by them (a failure never hides an item)
	project string
}

func (h *BoardHandler) goalDoneDriven(ctx context.Context, project string) goalDoneDrivenState {
	s := goalDoneDrivenState{project: project}
	if h.inboxSettings == nil {
		return s
	}
	st, err := h.inboxSettings(ctx)
	if err != nil {
		return s
	}
	if setreg.Bool(st, setreg.GoalDoneDrivenItems) {
		s.showAll = true
		return s
	}
	s.shown = goalDoneListFrom(st, setreg.GoalDoneShown)
	subs, err := h.bs.ListSubscribers(ctx, project)
	if err != nil {
		return s
	}
	s.active = subs
	s.orch, _ = h.bs.TeamOrchestrator(ctx, project)
	s.known = true
	return s
}

// hasDriver: the goal's driver is an active member of the board, or it has none and the team has an active Orchestrator (the one its driver's notice goes to).
func (s goalDoneDrivenState) hasDriver(g board.Goal) bool {
	who := g.Driver
	if who == "" {
		who = s.orch
	}
	if who == "" {
		return false
	}
	for _, sub := range s.active {
		if sub.IsActive != 0 && board.SameIdentity(sub.SubscriberID, who) {
			return true
		}
	}
	return false
}

func goalDoneShownPrefix(project string, id int64) string {
	return project + "|" + strconv.FormatInt(id, 10) + "|"
}

// goalDoneEpisode names the all-done state of a goal: when it looked done and how many tasks it had.
func goalDoneEpisode(g board.Goal) string {
	at := ""
	if g.LooksDoneAt != nil {
		at = *g.LooksDoneAt
	}
	return at + "|" + strconv.Itoa(g.Rollup.Total)
}

// skips: not an item. With the setting on, never. Otherwise a goal with a driver is not, and a goal is one only for the all-done state it was first shown at: the entry keeps the time it looked done, a goal
// reopened and done again has another and is not shown a second time.
func (s goalDoneDrivenState) skips(g board.Goal) bool {
	if s.showAll || !s.known {
		return false
	}
	if s.hasDriver(g) {
		return true
	}
	prefix := goalDoneShownPrefix(s.project, g.ID)
	seen := false
	for _, e := range s.shown {
		if strings.HasPrefix(e, prefix) {
			seen = true
			if e == prefix+goalDoneEpisode(g) {
				return false
			}
		}
	}
	return seen
}

// record keeps the first time a goal is an item (best effort: a goal that cannot be recorded is shown, as before).
func (s goalDoneDrivenState) record(ctx context.Context, h *BoardHandler, g board.Goal) {
	if s.showAll || !s.known || h.goalDoneEdit == nil {
		return
	}
	prefix := goalDoneShownPrefix(s.project, g.ID)
	for _, e := range s.shown {
		if strings.HasPrefix(e, prefix) {
			return
		}
	}
	entry := prefix + goalDoneEpisode(g)
	_, _ = h.goalDoneEdit(ctx, setreg.GoalDoneShown, goalDoneHiddenMax, func(l []string) []string { return append(withoutPrefix(l, prefix), entry) })
}
