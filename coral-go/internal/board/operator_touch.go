package board

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"
)

// Operator touches (#11225, for the Analytics tab "Operator interaction", #11222): one row each time the Operator acts on an agent by hand, so the tab can show how hands-on the work is and
// whether it falls over time. A row is a kind, an agent, a team and a time. It holds NO text and NO length, ever: nothing that was typed, answered or posted is stored or can be recovered from
// it, and the table has no column that could hold it. Rows older than TouchRetention are deleted (PruneOperatorTouches).

// Touch kinds. A board post by the Operator and a task approval are also in the board's own tables, but an approval at a permission prompt is not, so it is recorded here as an answer.
const (
	TouchTyped   = "typed"   // the Operator typed or pasted to an agent (its terminal or the chat box): one touch per burst, TouchBurst apart
	TouchAnswer  = "answer"  // the Operator answered an agent's question, plan or permission prompt
	TouchApprove = "approve" // the Operator approved a task
	TouchWake    = "wake"    // the Operator woke an agent by hand
	TouchRestart = "restart" // the Operator restarted an agent
	TouchStop    = "stop"    // the Operator stopped an agent's turn
)

// TouchKinds are the kinds, in the order the tab shows them.
var TouchKinds = []string{TouchTyped, TouchAnswer, TouchApprove, TouchWake, TouchRestart, TouchStop}

// Where a touch came from: the person at this computer (the dashboard, the signed command line), or a Coral Hub caller who may act on an agent (a grantee at Interact or Launch, or the owner on
// another device). The tab can then say which, and not count a grantee's hand as the Operator's (Security's #11225 SHOULD). One fixed word, never text.
const (
	TouchLocal = "local"
	TouchHub   = "hub"
)

// TouchRetention is how long touches are kept (90 days, the longest window a read may ask for).
const TouchRetention = 90 * 24 * time.Hour

// TouchBurst is how close two typed inputs to one agent are to count as one touch (the sink that writes them coalesces; see terminalinput).
const TouchBurst = 30 * time.Second

// MaxTouchRows bounds how many grouped rows one touches read returns.
const MaxTouchRows = 20000

// ErrBadTouch means the kind is not one of TouchKinds, the source is not local or hub, or the team or agent is empty.
var ErrBadTouch = errors.New("not an operator touch: the kind is unknown, or the team or agent is empty")

func (s *Store) ensureOperatorTouchSchema(ctx context.Context) error {
	for _, stmt := range []string{
		// The whole row. Adding a column that could hold text or a length would fail TestOperatorTouchHoldsNoText.
		`CREATE TABLE IF NOT EXISTS operator_touch (
			id    INTEGER PRIMARY KEY AUTOINCREMENT,
			at    TEXT NOT NULL,
			kind  TEXT NOT NULL,
			team  TEXT NOT NULL,
			agent TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'local'
		)`,
		`CREATE INDEX IF NOT EXISTS idx_operator_touch_team_at ON operator_touch(team, at)`,
	} {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	// A table made before the source column existed (a development build) gets it, every earlier row the person at this computer's.
	var has int
	if err := s.db.GetContext(ctx, &has, `SELECT COUNT(*) FROM pragma_table_info('operator_touch') WHERE name = 'source'`); err != nil {
		return err
	}
	if has == 0 {
		if _, err := s.db.ExecContext(ctx, `ALTER TABLE operator_touch ADD COLUMN source TEXT NOT NULL DEFAULT 'local'`); err != nil {
			return err
		}
	}
	return nil
}

// RecordOperatorTouch records one touch of agent (its label, as the board shows it) on team at at, from source (TouchLocal or TouchHub). Nothing else is taken: the signature has no text and no length
// to take.
func (s *Store) RecordOperatorTouch(ctx context.Context, team, agent, kind, source string, at time.Time) error {
	team, agent = strings.TrimSpace(team), strings.TrimSpace(agent)
	valid := false
	for _, k := range TouchKinds {
		valid = valid || k == kind
	}
	if !valid || team == "" || agent == "" || (source != TouchLocal && source != TouchHub) {
		return ErrBadTouch
	}
	if len(agent) > 120 {
		agent = agent[:120]
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO operator_touch (at, kind, team, agent, source) VALUES (?, ?, ?, ?, ?)`, at.UTC().Format(time.RFC3339), kind, team, agent, source)
	return err
}

// PruneOperatorTouches deletes the touches older than TouchRetention before now and returns how many.
func (s *Store) PruneOperatorTouches(ctx context.Context, now time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM operator_touch WHERE at < ?`, now.UTC().Add(-TouchRetention).Format(time.RFC3339))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// TouchCount is the number of touches of each kind.
type TouchCount struct {
	Typed   int `json:"typed"`
	Answer  int `json:"answer"`
	Approve int `json:"approve"`
	Wake    int `json:"wake"`
	Restart int `json:"restart"`
	Stop    int `json:"stop"`
}

func (c *TouchCount) add(kind string, n int) {
	switch kind {
	case TouchTyped:
		c.Typed += n
	case TouchAnswer:
		c.Answer += n
	case TouchApprove:
		c.Approve += n
	case TouchWake:
		c.Wake += n
	case TouchRestart:
		c.Restart += n
	case TouchStop:
		c.Stop += n
	}
}

// Total is every touch.
func (c TouchCount) Total() int { return c.Typed + c.Answer + c.Approve + c.Wake + c.Restart + c.Stop }

// TouchDay is one UTC day of touches by kind.
type TouchDay struct {
	Day string `json:"day"`
	TouchCount
}

// TouchAgent is one agent's touches by kind.
type TouchAgent struct {
	Name string `json:"name"`
	TouchCount
}

// TouchSources are the touches by where they came from.
type TouchSources struct {
	Local int `json:"local"`
	Hub   int `json:"hub"`
}

// Touches is a team's operator touches over a window: the totals by kind, by day and by agent (counts only).
type Touches struct {
	Kinds     TouchCount   `json:"kinds"`
	Sources   TouchSources `json:"sources"` // who made them: the person at this computer, or a caller through Coral Hub
	Days      []TouchDay   `json:"days"`
	Agents    []TouchAgent `json:"agents"`
	Truncated bool         `json:"truncated"` // more grouped rows than MaxTouchRows: the counts are of the first ones
}

// OperatorTouches counts team's touches in [since, until) (RFC 3339 UTC), at most 90 days, by one grouped query: the work is the number of (day, agent, kind) groups, not of touches.
func (s *Store) OperatorTouches(ctx context.Context, team, since, until string) (*Touches, error) {
	st, err1 := time.Parse(time.RFC3339, since)
	en, err2 := time.Parse(time.RFC3339, until)
	if err1 != nil || err2 != nil || !en.After(st) || en.Sub(st) > MaxActivityDays*24*time.Hour {
		return nil, ErrBadActivityWindow
	}
	var rows []struct {
		Day   string `db:"day"`
		Agent string `db:"agent"`
		Kind  string `db:"kind"`
		Src   string `db:"source"`
		N     int    `db:"n"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT substr(at, 1, 10) AS day, agent, kind, source, COUNT(*) AS n FROM operator_touch
		WHERE team = ? AND at >= ? AND at < ? GROUP BY day, agent, kind, source ORDER BY day LIMIT ?`, team, since, until, MaxTouchRows+1); err != nil {
		return nil, err
	}
	t := &Touches{Days: []TouchDay{}, Agents: []TouchAgent{}}
	if len(rows) > MaxTouchRows {
		rows, t.Truncated = rows[:MaxTouchRows], true
	}
	days, agents := map[string]*TouchDay{}, map[string]*TouchAgent{}
	for _, r := range rows {
		if days[r.Day] == nil {
			days[r.Day] = &TouchDay{Day: r.Day}
		}
		if agents[r.Agent] == nil {
			agents[r.Agent] = &TouchAgent{Name: r.Agent}
		}
		days[r.Day].add(r.Kind, r.N)
		agents[r.Agent].add(r.Kind, r.N)
		t.Kinds.add(r.Kind, r.N)
		if r.Src == TouchHub {
			t.Sources.Hub += r.N
		} else {
			t.Sources.Local += r.N
		}
	}
	for _, d := range days {
		t.Days = append(t.Days, *d)
	}
	sort.Slice(t.Days, func(i, j int) bool { return t.Days[i].Day < t.Days[j].Day })
	for _, a := range agents {
		t.Agents = append(t.Agents, *a)
	}
	sort.Slice(t.Agents, func(i, j int) bool {
		if ti, tj := t.Agents[i].Total(), t.Agents[j].Total(); ti != tj {
			return ti > tj
		}
		return t.Agents[i].Name < t.Agents[j].Name
	})
	return t, nil
}
