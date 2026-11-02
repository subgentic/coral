package board

import (
	"context"
	"sort"
	"time"
)

// Inbox versus chat (#12158, the Operator's Analytics tab): of the things the Operator did that the Inbox can do, how many were done in the Inbox and how many in a chat or terminal, per day, by kind and by team.
// COUNTS ONLY: a day, a kind, a team and a number come out; no text, no length and no id. The inputs are the Activity record's rows (an action's surface is what the page said: chat is chat, anything else is the
// Inbox, because the Activity record is the Inbox's own actions), and the Operator touches (typing to an agent is chat by its nature; an answer is the side the page said, or "not known" and then it is left out of
// the share rather than guessed). Waking, restarting and stopping an agent and approving a task are shown apart: the Inbox cannot do them. The comments the Operator wrote are added by the caller (they are in
// another database).

// InboxVsChatNote is the sentence the tab carries, the Activity record's own: the counts come from a record that detects edits and cannot prevent them.
const InboxVsChatNote = "These counts come from a record that detects edits made outside Coral but cannot prevent them: it is a record for you, not an audit. Edits made outside Coral are shown unless the whole record was rewritten."

// IVCDay is one UTC day: the actions of each side, and the answers whose side is not known.
type IVCDay struct {
	Day     string `json:"day"`
	Inbox   int    `json:"inbox"`
	Chat    int    `json:"chat"`
	Unknown int    `json:"unknown"`
}

// IVCTeam is one team's actions by side.
type IVCTeam struct {
	Team  string `json:"team"`
	Inbox int    `json:"inbox"`
	Chat  int    `json:"chat"`
}

// InboxVsChat is the whole answer.
type InboxVsChat struct {
	Days    []IVCDay       `json:"days"`
	Inbox   map[string]int `json:"inbox"`   // by kind of action
	Chat    map[string]int `json:"chat"`    // by kind of action
	Unknown map[string]int `json:"unknown"` // answers whose side the page did not say
	Apart   map[string]int `json:"apart"`   // wake, restart, stop, task approvals: not in the share
	Teams   []IVCTeam      `json:"teams"`
	// Phone is the Inbox's actions by where they were taken, as the page said: from a phone, or not said.
	Phone struct {
		Phone int `json:"phone"`
		Other int `json:"other"`
	} `json:"phone"`
	// RecordSince is the day of the oldest row of the Activity record ("" for none): before it the Inbox's side cannot be told apart, so the share starts there.
	RecordSince string `json:"record_since"`
	Note        string `json:"note"`
}

// InboxVsChatCounts reads the two tables for [since, until) (RFC 3339 UTC, at most MaxActivityDays), of team or of every team when it is "". The touches carry no actor, so these counts are the whole computer's: a
// route that must show a team's owner only their own rows refuses instead of calling this (see the route).
func (s *Store) InboxVsChatCounts(ctx context.Context, team, since, until string) (*InboxVsChat, error) {
	st, err1 := time.Parse(time.RFC3339, since)
	en, err2 := time.Parse(time.RFC3339, until)
	if err1 != nil || err2 != nil || !en.After(st) || en.Sub(st) > MaxActivityDays*24*time.Hour {
		return nil, ErrBadActivityWindow
	}
	// The record's times are UTC with milliseconds, fixed width: "2026-11-02T05:41:12.304Z" sorts as text against the window's edges in the same form.
	lo, hi := st.UTC().Format(activityTimeFormat), en.UTC().Format(activityTimeFormat)
	out := &InboxVsChat{Days: []IVCDay{}, Inbox: map[string]int{}, Chat: map[string]int{}, Unknown: map[string]int{}, Apart: map[string]int{}, Teams: []IVCTeam{}, Note: InboxVsChatNote}
	days := map[string]*IVCDay{}
	teams := map[string]*IVCTeam{}
	day := func(d string) *IVCDay {
		if days[d] == nil {
			days[d] = &IVCDay{Day: d}
		}
		return days[d]
	}
	teamOf := func(t string) *IVCTeam {
		if teams[t] == nil {
			teams[t] = &IVCTeam{Team: t}
		}
		return teams[t]
	}
	// the Activity record
	var acts []struct {
		Day, Team, Action, Surface, Hint string
		N                                int
	}
	q := `SELECT substr(at, 1, 10) AS day, team, action, surface, hint, COUNT(*) AS n FROM operator_actions WHERE at >= ? AND at < ? AND action != ?`
	args := []any{lo, hi, ActUndone}
	if team != "" {
		q += ` AND team = ?`
		args = append(args, team)
	}
	q += ` GROUP BY day, team, action, surface, hint LIMIT 20000`
	if err := s.reader().SelectContext(ctx, &acts, q, args...); err != nil {
		return nil, err
	}
	for _, a := range acts {
		if a.Surface == SurfaceChat {
			day(a.Day).Chat += a.N
			teamOf(a.Team).Chat += a.N
			out.Chat[a.Action] += a.N
			continue
		}
		day(a.Day).Inbox += a.N
		teamOf(a.Team).Inbox += a.N
		out.Inbox[a.Action] += a.N
		if a.Hint == "phone" {
			out.Phone.Phone += a.N
		} else {
			out.Phone.Other += a.N
		}
	}
	// the touches
	var ts []struct {
		Day, Team, Kind, Surface string
		N                        int
	}
	tq := `SELECT substr(at, 1, 10) AS day, team, kind, surface, COUNT(*) AS n FROM operator_touch WHERE at >= ? AND at < ?`
	targs := []any{since, until}
	if team != "" {
		tq += ` AND team = ?`
		targs = append(targs, team)
	}
	tq += ` GROUP BY day, team, kind, surface LIMIT 20000`
	if err := s.reader().SelectContext(ctx, &ts, tq, targs...); err != nil {
		return nil, err
	}
	for _, t := range ts {
		switch {
		case t.Kind == TouchTyped: // typing to an agent is chat by its nature
			day(t.Day).Chat += t.N
			teamOf(t.Team).Chat += t.N
			out.Chat["typed"] += t.N
		case t.Kind == TouchAnswer && t.Surface == SurfaceInbox:
			day(t.Day).Inbox += t.N
			teamOf(t.Team).Inbox += t.N
			out.Inbox["answer_prompt"] += t.N
		case t.Kind == TouchAnswer && t.Surface == SurfaceChat:
			day(t.Day).Chat += t.N
			teamOf(t.Team).Chat += t.N
			out.Chat["answer_prompt"] += t.N
		case t.Kind == TouchAnswer: // the same route serves both: with no word from the page its side is not known, and it is left out of the share
			day(t.Day).Unknown += t.N
			out.Unknown["answer_prompt"] += t.N
		default: // wake, restart, stop, a task's approval: the Inbox cannot do these, so they are not in the share
			out.Apart[t.Kind] += t.N
		}
	}
	var first string
	if err := s.reader().GetContext(ctx, &first, `SELECT COALESCE(MIN(substr(at, 1, 10)), '') FROM operator_actions`); err != nil {
		return nil, err
	}
	out.RecordSince = first
	for _, d := range days {
		out.Days = append(out.Days, *d)
	}
	sort.Slice(out.Days, func(i, j int) bool { return out.Days[i].Day < out.Days[j].Day })
	for _, t := range teams {
		out.Teams = append(out.Teams, *t)
	}
	sort.Slice(out.Teams, func(i, j int) bool {
		a, b := out.Teams[i], out.Teams[j]
		if a.Inbox+a.Chat != b.Inbox+b.Chat {
			return a.Inbox+a.Chat > b.Inbox+b.Chat
		}
		return a.Team < b.Team
	})
	return out, nil
}

// AddComments adds the Operator's own comments (a count of one day on one team's files and goals) to the Inbox's side: a comment is written in the viewer or a goal's Comments tab, never in a chat. The
// caller read the count from the comments' own database; nothing of a comment is here but how many.
func (r *InboxVsChat) AddComments(day, team string, n int) {
	if n <= 0 {
		return
	}
	r.Inbox["comment"] += n
	found := false
	for i := range r.Days {
		if r.Days[i].Day == day {
			r.Days[i].Inbox += n
			found = true
		}
	}
	if !found {
		r.Days = append(r.Days, IVCDay{Day: day, Inbox: n})
		sort.Slice(r.Days, func(i, j int) bool { return r.Days[i].Day < r.Days[j].Day })
	}
	if team == "" {
		return
	}
	for i := range r.Teams {
		if r.Teams[i].Team == team {
			r.Teams[i].Inbox += n
			return
		}
	}
	r.Teams = append(r.Teams, IVCTeam{Team: team, Inbox: n})
}
