package board

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"time"
	"unicode"
)

// Counts for the Analytics tabs "Operator interaction" and "Team communication" (#11222), from what the board already stores. Counts only: a message's text is read to find who it @mentions and is
// never kept or returned. Every read is bounded by a window (at most 90 days) and by MaxActivityRows messages; past it the result says Truncated.

// MaxActivityRows bounds how many messages one activity read looks at.
const MaxActivityRows = 50000

// MaxActivityDays bounds the window of an activity read.
const MaxActivityDays = 90

// ActivityDay is one UTC day of counts.
type ActivityDay struct {
	Day       string `json:"day"`
	Posts     int    `json:"posts"`     // messages written by agents on this board (not Coral's own, not the Operator's, not another team's)
	Cross     int    `json:"cross"`     // messages from or to another team (inbound and outbound copies)
	Automated int    `json:"automated"` // Coral Task Queue, Coral Health Monitor and the other notices Coral writes
	Operator  int    `json:"operator"`  // the Operator's own board posts (the dashboard, the command line, Coral Hub as the Operator)
	TasksDone int    `json:"tasks_done"`
}

// ActivityEdge is how often one agent @mentioned another.
type ActivityEdge struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Count int    `json:"count"`
}

// ActivityAgent is one agent's messages sent and received (an @mention is a received message).
type ActivityAgent struct {
	Name         string `json:"name"`
	Sent         int    `json:"sent"`
	Received     int    `json:"received"`
	ToOperator   int    `json:"to_operator"` // messages that @mention the Operator
	AsksOperator int    `json:"asks_operator"`
}

// ActivityAsks is the asks (post --ask) of a window and how long they waited.
type ActivityAsks struct {
	Asked    int      `json:"asked"`
	Answered int      `json:"answered"`
	MedianS  *float64 `json:"median_s"`
	SlowestS *float64 `json:"slowest_s"`
}

// Activity is one board's counts over a window.
type Activity struct {
	Project        string          `json:"project"`
	Since          string          `json:"since"`
	Until          string          `json:"until"`
	Days           []ActivityDay   `json:"days"`
	Agents         []ActivityAgent `json:"agents"`
	Edges          []ActivityEdge  `json:"edges"`
	Asks           ActivityAsks    `json:"asks"`           // asks between agents
	OperatorAsks   ActivityAsks    `json:"operator_asks"`  // asks whose asked is the Operator
	Assigned       int             `json:"assigned"`       // tasks one agent created for another
	TasksDone      int             `json:"tasks_done"`     // tasks completed in the window
	Truncated      bool            `json:"truncated"`      // the window held more messages than were counted
	OperatorPosts  int             `json:"operator_posts"` // the Operator's board posts
	AgentPosts     int             `json:"agent_posts"`
	AutomatedPosts int             `json:"automated_posts"`
	CrossPosts     int             `json:"cross_posts"`
	// Touches and TaskMessages are filled by the read's handler from the operator_touch table and the task windows (#11225): counts only. Absent (not an empty list) when they could not be read.
	Touches      *Touches        `json:"touches,omitempty"`
	TaskMessages *[]TaskMessages `json:"task_messages,omitempty"` // a pointer: an empty list is sent (no task was in progress), a read that failed is left out
}

type activityMsg struct {
	ID        int64   `db:"id"`
	Sender    string  `db:"subscriber_id"`
	Title     *string `db:"job_title"`
	Content   string  `db:"content"`
	CreatedAt string  `db:"created_at"`
	IsSystem  bool    `db:"is_system"`
	Origin    *string `db:"origin"`
	External  *string `db:"external_json"`
}

// ErrBadActivityWindow means the window is not a forward range of at most MaxActivityDays.
var ErrBadActivityWindow = errString("the window must run forward and be at most 90 days")

type errString string

func (e errString) Error() string { return string(e) }

// BoardActivity counts a board's messages, mentions, asks and tasks in [since, until) (RFC 3339 UTC).
func (s *Store) BoardActivity(ctx context.Context, project, since, until string) (*Activity, error) {
	st, err1 := time.Parse(time.RFC3339, since)
	en, err2 := time.Parse(time.RFC3339, until)
	if err1 != nil || err2 != nil || !en.After(st) || en.Sub(st) > MaxActivityDays*24*time.Hour {
		return nil, ErrBadActivityWindow
	}
	var msgs []activityMsg
	err := s.reader().SelectContext(ctx, &msgs, `SELECT m.id, COALESCE(m.subscriber_id, '') AS subscriber_id, s.job_title, m.content, m.created_at, m.is_system, m.origin, m.external_json
		FROM board_messages m LEFT JOIN board_subscribers s ON m.project = s.project AND m.subscriber_id = s.subscriber_id
		WHERE m.project = ? AND m.created_at >= ? AND m.created_at < ? ORDER BY m.id LIMIT ?`, project, since, until, MaxActivityRows+1)
	if err != nil {
		return nil, err
	}
	a := &Activity{Project: project, Since: since, Until: until, Days: []ActivityDay{}, Agents: []ActivityAgent{}, Edges: []ActivityEdge{}}
	if len(msgs) > MaxActivityRows {
		msgs, a.Truncated = msgs[:MaxActivityRows], true
	}
	var titles []struct {
		ID    string  `db:"subscriber_id"`
		Title *string `db:"job_title"`
	}
	if err := s.reader().SelectContext(ctx, &titles, `SELECT subscriber_id, job_title FROM board_subscribers WHERE project = ? AND subscriber_id IS NOT NULL`, project); err != nil {
		return nil, err
	}
	nameOf := map[string]string{}
	var names []string
	seen := map[string]bool{}
	for _, t := range titles {
		n := t.ID
		if t.Title != nil && *t.Title != "" {
			n = *t.Title
		}
		nameOf[t.ID] = n
		if !seen[n] && !IsOperatorName(n) && !isAutomatedSender(n) && len(n) >= 2 {
			seen[n] = true
			names = append(names, n)
		}
	}
	sort.Slice(names, func(i, j int) bool {
		return len(names[i]) > len(names[j]) || (len(names[i]) == len(names[j]) && names[i] < names[j])
	}) // "Backend Dev 2" before "Backend Dev"
	days := map[string]*ActivityDay{}
	day := func(ts string) *ActivityDay {
		d := ts
		if len(d) >= 10 {
			d = d[:10]
		}
		if days[d] == nil {
			days[d] = &ActivityDay{Day: d}
		}
		return days[d]
	}
	agents := map[string]*ActivityAgent{}
	agent := func(n string) *ActivityAgent {
		if agents[n] == nil {
			agents[n] = &ActivityAgent{Name: n}
		}
		return agents[n]
	}
	edges := map[[2]string]int{}
	for _, m := range msgs {
		d := day(m.CreatedAt)
		name := m.Sender
		if m.Title != nil && *m.Title != "" {
			name = *m.Title
		}
		fromOperator := IsOperatorName(m.Sender) || (m.Origin != nil && *m.Origin == OriginHubOperator)
		switch {
		case m.External != nil && *m.External != "":
			d.Cross++
			a.CrossPosts++
		case m.IsSystem || (m.Origin != nil && *m.Origin == OriginHubNotice) || isAutomatedSender(m.Sender):
			d.Automated++
			a.AutomatedPosts++
		case fromOperator:
			d.Operator++
			a.OperatorPosts++
		default:
			d.Posts++
			a.AgentPosts++
			agent(name).Sent++
			for _, to := range mentionedNames(m.Content, names) {
				if to == name {
					continue
				}
				agent(to).Received++
				edges[[2]string{name, to}]++
			}
			if mentionsOperator(m.Content) {
				agent(name).ToOperator++
			}
		}
	}
	a.Asks, a.OperatorAsks, err = s.askCounts(ctx, project, since, until, nameOf, agents)
	if err != nil {
		return nil, err
	}
	var tasks []struct {
		CreatedBy   string  `db:"created_by"`
		AssignedTo  *string `db:"assigned_to"`
		CompletedAt *string `db:"completed_at"`
		Status      string  `db:"status"`
		CreatedAt   string  `db:"created_at"`
	}
	if err := s.reader().SelectContext(ctx, &tasks, `SELECT created_by, assigned_to, completed_at, status, created_at FROM board_tasks
		WHERE board_id = ? AND ((created_at >= ? AND created_at < ?) OR (status = 'completed' AND completed_at >= ? AND completed_at < ?)) LIMIT ?`, project, since, until, since, until, MaxActivityRows); err != nil {
		return nil, err
	}
	for _, t := range tasks {
		if t.Status == "completed" && t.CompletedAt != nil && *t.CompletedAt >= since && *t.CompletedAt < until {
			day(*t.CompletedAt).TasksDone++
			a.TasksDone++
		}
		if t.CreatedAt >= since && t.CreatedAt < until && t.AssignedTo != nil && *t.AssignedTo != "" && !SameIdentity(t.CreatedBy, *t.AssignedTo) && !isAutomatedSender(t.CreatedBy) && !IsOperatorName(t.CreatedBy) {
			a.Assigned++
		}
	}
	for k, n := range edges {
		a.Edges = append(a.Edges, ActivityEdge{From: k[0], To: k[1], Count: n})
	}
	sort.Slice(a.Edges, func(i, j int) bool {
		if a.Edges[i].Count != a.Edges[j].Count {
			return a.Edges[i].Count > a.Edges[j].Count
		}
		return a.Edges[i].From+a.Edges[i].To < a.Edges[j].From+a.Edges[j].To
	})
	for _, v := range agents {
		a.Agents = append(a.Agents, *v)
	}
	sort.Slice(a.Agents, func(i, j int) bool {
		if a.Agents[i].Sent != a.Agents[j].Sent {
			return a.Agents[i].Sent > a.Agents[j].Sent
		}
		return a.Agents[i].Name < a.Agents[j].Name
	})
	for d := st.UTC().Truncate(24 * time.Hour); d.Before(en); d = d.AddDate(0, 0, 1) { // a day with nothing is a day of zeros, so the axis is whole
		k := d.Format("2006-01-02")
		if days[k] == nil {
			days[k] = &ActivityDay{Day: k}
		}
	}
	for _, v := range days {
		a.Days = append(a.Days, *v)
	}
	sort.Slice(a.Days, func(i, j int) bool { return a.Days[i].Day < a.Days[j].Day })
	return a, nil
}

func isAutomatedSender(s string) bool {
	for _, n := range ReservedNames {
		if strings.EqualFold(n, s) && !IsOperatorName(s) {
			return true
		}
	}
	return false
}

func mentionsOperator(content string) bool {
	return len(mentionedNames(content, []string{OperatorName})) > 0
}

// mentionedNames lists which of names (longest first) content @mentions: "@Backend Dev 2" counts for "Backend Dev 2" and not for "Backend Dev". Each name counts once a message.
func mentionedNames(content string, names []string) []string {
	lc := strings.ToLower(content)
	var out []string
	done := map[string]bool{}
	for i := 0; i < len(lc); i++ {
		if lc[i] != '@' {
			continue
		}
		rest := lc[i+1:]
		for _, n := range names {
			ln := strings.ToLower(n)
			if !strings.HasPrefix(rest, ln) {
				continue
			}
			if tail := rest[len(ln):]; tail != "" {
				r := []rune(tail)[0]
				if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-' {
					continue
				}
			}
			if !done[n] {
				done[n] = true
				out = append(out, n)
			}
			break
		}
	}
	return out
}

// askCounts reads the asks (board_asks) created in the window and how long each waited for its first reply: asks between agents, and asks of the Operator.
func (s *Store) askCounts(ctx context.Context, project, since, until string, nameOf map[string]string, agents map[string]*ActivityAgent) (ActivityAsks, ActivityAsks, error) {
	var rows []struct {
		ID      int64   `db:"message_id"`
		Asker   string  `db:"asker"`
		Asked   string  `db:"asked"`
		Created string  `db:"created_at"`
		Replied *string `db:"replied_at"`
	}
	err := s.reader().SelectContext(ctx, &rows, `SELECT a.message_id, a.asker, a.asked, a.created_at,
		(SELECT MIN(m.created_at) FROM board_replies r JOIN board_messages m ON m.id = r.message_id WHERE r.project = a.project AND r.reply_to = a.message_id) AS replied_at
		FROM board_asks a WHERE a.project = ? AND a.created_at >= ? AND a.created_at < ? LIMIT ?`, project, since, until, MaxActivityRows)
	if err != nil {
		return ActivityAsks{}, ActivityAsks{}, err
	}
	var agentWaits, opWaits []float64
	var agentAsks, opAsks ActivityAsks
	for _, r := range rows {
		var asked []string
		_ = json.Unmarshal([]byte(r.Asked), &asked)
		toOp := false
		for _, x := range asked {
			if IsOperatorName(x) {
				toOp = true
			}
		}
		asker := r.Asker
		if n, ok := nameOf[asker]; ok {
			asker = n
		}
		tgt, waits := &agentAsks, &agentWaits
		if toOp {
			tgt, waits = &opAsks, &opWaits
			if !IsOperatorName(asker) {
				if ag, ok := agents[asker]; ok {
					ag.AsksOperator++
				} else {
					agents[asker] = &ActivityAgent{Name: asker, AsksOperator: 1}
				}
			}
		}
		tgt.Asked++
		if r.Replied != nil {
			t0, e0 := time.Parse(time.RFC3339, r.Created)
			t1, e1 := time.Parse(time.RFC3339, *r.Replied)
			if e0 == nil && e1 == nil && !t1.Before(t0) {
				tgt.Answered++
				*waits = append(*waits, t1.Sub(t0).Seconds())
			}
		}
	}
	fill := func(a *ActivityAsks, w []float64) {
		if len(w) == 0 {
			return
		}
		sort.Float64s(w)
		med, slow := w[len(w)/2], w[len(w)-1]
		a.MedianS, a.SlowestS = &med, &slow
	}
	fill(&agentAsks, agentWaits)
	fill(&opAsks, opWaits)
	return agentAsks, opAsks, nil
}
