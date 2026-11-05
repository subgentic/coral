package resources

import (
	"database/sql"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// The record of the queue's use as a list of runs (#13724, the Operator's "history of the runs"): one row per entry that ended, newest first, with when it joined the line, when it started, how long it waited and
// held, and how it ended. It is read from the same file as the analytics (resource_events); nothing here is a command, a note or a path: the pattern is the hook's matched pattern.

// How a run ended: a stable code (the page says it in words).
const (
	EndReleased       = "released"         // the agent gave the slot back
	EndCallEnded      = "call_ended"       // the shell hook gave it back when its command ended
	EndUnused         = "unused"           // granted to a waiting agent that never ran the command
	EndCap            = "cap"              // the hook gave it back at its time cap
	EndGone           = "gone"             // the agent's session ended
	EndExpired        = "expired"          // the lease ran out
	EndKicked         = "kicked"           // a person removed a holder
	EndKickedFromLine = "kicked_from_line" // a person removed an entry that was still waiting
	EndLeftLine       = "left_line"        // the agent left the line itself
	EndRanAnyway      = "ran_anyway"       // the CLI ran the command that was refused: its place in line went
)

// RunsPageSize is the most runs one read answers (the Operator's "paged at 50").
const RunsPageSize = 50

// endWords are what a person may type to find runs by how they ended (the page's own words, lower case).
var endWords = map[string]string{
	EndReleased: "released", EndCallEnded: "call ended", EndUnused: "not used", EndCap: "time cap", EndGone: "session ended",
	EndExpired: "lease ran out", EndKicked: "kicked", EndKickedFromLine: "kicked from the line", EndLeftLine: "left the line", EndRanAnyway: "ran anyway",
}

// Run is one entry of the queue that ended.
type Run struct {
	Key      string // the cursor position: stable, unique
	Entry    int64
	Resource string
	Agent    string
	Task     int
	Project  string // the board of the task; "" for a row from before the record kept it (the task is then text, not a link)
	Via      string // "hook" for an automatic claim
	Pattern  string
	Enqueued time.Time
	Granted  time.Time // zero when it never ran
	Ended    time.Time
	Wait     time.Duration
	Held     time.Duration
	End      string
}

// RunsQuery is a read: filters (empty: none), a search, a cursor and a page size.
type RunsQuery struct {
	Resource string
	Agent    string
	Search   string
	Before   string // the previous page's Next
	Limit    int    // at most RunsPageSize
}

// RunsPage is one page of runs, the cursor for the next (empty at the end) and the names to filter by.
type RunsPage struct {
	Runs      []Run
	Next      string
	Resources []string
	Agents    []string
}

// migrate brings a file made by an earlier release up to the current shape: the project and why columns (added in #13724) and the index the runs read uses. Old rows keep their data; their new fields are empty.
func migrate(db *sql.DB) error {
	have := map[string]bool{}
	rows, err := db.Query(`SELECT name FROM pragma_table_info('resource_events')`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			_ = rows.Close()
			return err
		}
		have[n] = true
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, c := range []string{"project", "why"} {
		if !have[c] {
			if _, err := db.Exec(`ALTER TABLE resource_events ADD COLUMN ` + c + ` TEXT NOT NULL DEFAULT ''`); err != nil {
				return err
			}
		}
	}
	_, err = db.Exec(`CREATE INDEX IF NOT EXISTS resource_events_entry ON resource_events(resource, entry, kind, at)`)
	return err
}

func endOf(kind, why string, granted bool) string {
	switch why {
	case "call ended":
		return EndCallEnded
	case "unclaimed":
		return EndUnused
	case "cap":
		return EndCap
	case "gone":
		return EndGone
	case "ran anyway":
		return EndRanAnyway
	}
	switch kind {
	case "expired":
		return EndExpired
	case "kicked":
		if granted {
			return EndKicked
		}
		return EndKickedFromLine
	case "gone":
		return EndGone
	case "cancelled":
		return EndLeftLine
	}
	return EndReleased
}

func cursorOf(at int64, rid int64) string {
	return strconv.FormatInt(at, 10) + "-" + strconv.FormatInt(rid, 10)
}

func parseCursor(c string) (at, rid int64, err error) {
	a, b, ok := strings.Cut(c, "-")
	if !ok {
		return 0, 0, fmt.Errorf("resources: not a cursor")
	}
	if at, err = strconv.ParseInt(a, 10, 64); err != nil {
		return 0, 0, fmt.Errorf("resources: not a cursor")
	}
	if rid, err = strconv.ParseInt(b, 10, 64); err != nil {
		return 0, 0, fmt.Errorf("resources: not a cursor")
	}
	return at, rid, nil
}

// Runs reads one page of runs. machines maps a resource to its machine name for the search (nil: not searched by machine).
func (h *History) Runs(q RunsQuery) (RunsPage, error) {
	return h.RunsOn(q, nil)
}

// RunsOn is Runs with the machine each resource is on, so a search for "mini" finds the runs on the resource that lives there.
func (h *History) RunsOn(q RunsQuery, machines map[string]string) (RunsPage, error) {
	var page RunsPage
	if h == nil {
		return page, fmt.Errorf("resources: no history")
	}
	limit := q.Limit
	if limit <= 0 || limit > RunsPageSize {
		limit = RunsPageSize
	}
	where := []string{`e.kind IN ('released','cancelled','kicked','expired','gone')`}
	var args []any
	if q.Resource != "" {
		where = append(where, `e.resource = ?`)
		args = append(args, q.Resource)
	}
	if q.Agent != "" {
		where = append(where, `e.agent = ?`)
		args = append(args, q.Agent)
	}
	if t := strings.ToLower(strings.TrimSpace(q.Search)); t != "" {
		like := "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(t) + "%"
		or := []string{`lower(e.agent) LIKE ? ESCAPE '\'`, `lower(e.resource) LIKE ? ESCAPE '\'`, `lower(e.pattern) LIKE ? ESCAPE '\'`, `lower(e.project) LIKE ? ESCAPE '\'`, `('#' || e.task) LIKE ? ESCAPE '\'`}
		args = append(args, like, like, like, like, like)
		var kinds []string // how it ended, by the words the page uses
		for code, w := range endWords {
			if strings.Contains(w, t) {
				kinds = append(kinds, code)
			}
		}
		if len(kinds) > 0 {
			ends, endArgs := endClause(kinds)
			or = append(or, ends)
			args = append(args, endArgs...)
		}
		var onMachine []string // a machine named: the resources that live there
		for res, m := range machines {
			if m != "" && strings.Contains(strings.ToLower(m), t) {
				onMachine = append(onMachine, res)
			}
		}
		if len(onMachine) > 0 {
			or = append(or, `e.resource IN (`+strings.TrimSuffix(strings.Repeat("?,", len(onMachine)), ",")+`)`)
			for _, r := range onMachine {
				args = append(args, r)
			}
		}
		where = append(where, "("+strings.Join(or, " OR ")+")")
	}
	if q.Before != "" {
		at, rid, err := parseCursor(q.Before)
		if err != nil {
			return page, err
		}
		where = append(where, `(e.at < ? OR (e.at = ? AND e.rowid < ?))`)
		args = append(args, at, at, rid)
	}
	query := `SELECT e.rowid, e.at, e.kind, e.resource, e.agent, e.task, e.entry, e.via, e.pattern, e.project, e.why, e.wait_ms, e.held_ms,
		COALESCE((SELECT g.at FROM resource_events g WHERE g.resource = e.resource AND g.entry = e.entry AND g.kind = 'granted' AND g.at <= e.at ORDER BY g.at DESC, g.rowid DESC LIMIT 1), 0),
		COALESCE((SELECT g.wait_ms FROM resource_events g WHERE g.resource = e.resource AND g.entry = e.entry AND g.kind = 'granted' AND g.at <= e.at ORDER BY g.at DESC, g.rowid DESC LIMIT 1), -1),
		COALESCE((SELECT g.at FROM resource_events g WHERE g.resource = e.resource AND g.entry = e.entry AND g.kind = 'enqueued' AND g.at <= e.at ORDER BY g.at DESC, g.rowid DESC LIMIT 1), 0)
		FROM resource_events e WHERE ` + strings.Join(where, " AND ") + ` ORDER BY e.at DESC, e.rowid DESC LIMIT ?`
	args = append(args, limit+1)
	rows, err := h.db.Query(query, args...)
	if err != nil {
		return page, err
	}
	type rawRun struct {
		Run
		at, rid int64
	}
	var raw []rawRun
	for rows.Next() {
		var r rawRun
		var kind, why string
		var at, wait, held, grantedAt, grantedWait, enqAt int64
		if err := rows.Scan(&r.rid, &at, &kind, &r.Resource, &r.Agent, &r.Task, &r.Entry, &r.Via, &r.Pattern, &r.Project, &why, &wait, &held, &grantedAt, &grantedWait, &enqAt); err != nil {
			_ = rows.Close()
			return page, err
		}
		r.at = at
		r.Ended = time.UnixMilli(at).UTC()
		if grantedAt > 0 {
			r.Granted = time.UnixMilli(grantedAt).UTC()
			r.Held = time.Duration(held) * time.Millisecond
			if grantedWait >= 0 {
				r.Wait = time.Duration(grantedWait) * time.Millisecond
			}
		} else {
			r.Wait = time.Duration(wait) * time.Millisecond // it left the line without a slot: the time it waited
		}
		if enqAt > 0 {
			r.Enqueued = time.UnixMilli(enqAt).UTC()
		}
		r.End = endOf(kind, why, grantedAt > 0)
		raw = append(raw, r)
	}
	if err := rows.Close(); err != nil {
		return page, err
	}
	if len(raw) > limit {
		last := raw[limit-1]
		page.Next = cursorOf(last.at, last.rid)
		raw = raw[:limit]
	}
	for _, r := range raw {
		r.Key = cursorOf(r.at, r.rid)
		page.Runs = append(page.Runs, r.Run)
	}
	for _, o := range []struct {
		col string
		dst *[]string
	}{{"resource", &page.Resources}, {"agent", &page.Agents}} {
		names, err := h.distinct(o.col)
		if err != nil {
			return page, err
		}
		*o.dst = names
	}
	return page, nil
}

// endClause is a SQL test for "ended in one of these ways": the event kind, and for the hook's reasons the why.
func endClause(codes []string) (string, []any) {
	var parts []string
	var args []any
	kinds, whys := map[string]bool{}, map[string]bool{}
	for _, c := range codes {
		switch c {
		case EndReleased:
			parts = append(parts, `(e.kind = 'released' AND e.why = '')`)
		case EndCallEnded:
			whys["call ended"] = true
		case EndUnused:
			whys["unclaimed"] = true
		case EndCap:
			whys["cap"] = true
		case EndRanAnyway:
			whys["ran anyway"] = true
		case EndGone:
			kinds["gone"] = true
			whys["gone"] = true
		case EndExpired:
			kinds["expired"] = true
		case EndKicked, EndKickedFromLine:
			kinds["kicked"] = true
		case EndLeftLine:
			parts = append(parts, `(e.kind = 'cancelled' AND e.why = '')`)
		}
	}
	for k := range kinds {
		parts = append(parts, `e.kind = ?`)
		args = append(args, k)
	}
	for w := range whys {
		parts = append(parts, `e.why = ?`)
		args = append(args, w)
	}
	if len(parts) == 0 {
		return `0`, nil
	}
	return "(" + strings.Join(parts, " OR ") + ")", args
}

func (h *History) distinct(col string) ([]string, error) {
	rows, err := h.db.Query(`SELECT DISTINCT ` + col + ` FROM resource_events WHERE kind IN ('released','cancelled','kicked','expired','gone') AND ` + col + ` <> '' ORDER BY ` + col)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}
