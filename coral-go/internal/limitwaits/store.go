// Package limitwaits records the limit waits of the agents (feature bets stage 1, task 2, #21020): each time an agent is stopped by its vendor's usage limit it waits, and then it resumes at the
// reset time the vendor gave or earlier. One row per wait, kept 90 days in a small SQLite file of its own; the cost page counts the waits, the resumes at reset and the early resumes per agent and day.
// A row holds an agent's name, its team, the vendor and three times. It never holds a message, a command, a path or the CLI's text.
package limitwaits

import (
	"database/sql"
	"os"
	"sort"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// KeepDays is how long the waits are kept.
const KeepDays = 90

// How a wait ended.
const (
	EndedAtReset = "reset"   // the agent was working again at the reset time or after it
	EndedEarly   = "early"   // the agent was working again before the reset time (a person resumed it, a new login, a reroute)
	EndedGone    = "gone"    // the agent went away (stopped, asleep, archived) while it waited: neither a resume at reset nor an early one
	EndedUnknown = "unknown" // the agent is working again but the CLI named no reset time, so it cannot be told at reset from early
)

// Wait is one limit wait.
type Wait struct {
	ID        int64
	SessionID string
	Agent     string // the agent's name (its role), as the cost page shows it
	Team      string // its board's name, "" when it is on none
	Vendor    string // claude, codex or agy
	StartedAt time.Time
	ResetAt   time.Time // zero: the CLI printed no time
	EndedAt   time.Time // zero while it waits
	Ended     string    // "", or one of the Ended constants
}

// Store is the record.
type Store struct {
	db   *sql.DB
	mu   sync.Mutex
	path string
	seen map[string]int64 // an agent's last sighting written, by agent and team: a sighting is written once a quarter of an hour
}

// Open opens (and makes) the file. Waits older than KeepDays are removed.
func Open(path string) (*Store, error) {
	if f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600); err != nil { // private before SQLite opens it: it makes its -wal and -shm with the file's mode
		return nil, err
	} else {
		_ = f.Close()
	}
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(2000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS limit_waits (
		id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, agent TEXT NOT NULL, team TEXT NOT NULL DEFAULT '', vendor TEXT NOT NULL DEFAULT '',
		started_at INTEGER NOT NULL, reset_at INTEGER NOT NULL DEFAULT 0, ended_at INTEGER NOT NULL DEFAULT 0, ended TEXT NOT NULL DEFAULT '');
		CREATE INDEX IF NOT EXISTS limit_waits_started ON limit_waits(started_at);
		CREATE TABLE IF NOT EXISTS agent_seen (agent TEXT NOT NULL, team TEXT NOT NULL DEFAULT '', slot INTEGER NOT NULL, PRIMARY KEY (agent, team, slot)) WITHOUT ROWID`); err != nil {
		_ = db.Close()
		return nil, err
	}
	s := &Store{db: db, path: path, seen: map[string]int64{}}
	s.prune(time.Now())
	for _, suffix := range []string{"", "-wal", "-shm"} {
		_ = os.Chmod(path+suffix, 0o600)
	}
	return s, nil
}

// Close closes the file.
func (s *Store) Close() error { return s.db.Close() }

func (s *Store) prune(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cut := now.Add(-KeepDays * 24 * time.Hour)
	_, _ = s.db.Exec(`DELETE FROM limit_waits WHERE started_at < ?`, cut.UnixMilli())
	_, _ = s.db.Exec(`DELETE FROM agent_seen WHERE slot < ?`, cut.Unix()/seenSlot)
}

// seenSlot is how long a sighting stands for, in seconds: the day of a sighting is read in any zone, down to the quarter-hour ones.
const seenSlot = 15 * 60

// Seen notes that an agent (by its name, on its team) was there at a time: the cost page draws an agent that had no wait as a row of zeros on a day that had some (the approved mock, #21017).
func (s *Store) Seen(agent, team string, at time.Time) error {
	slot := at.Unix() / seenSlot
	k := agent + "\x00" + team
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.seen[k] == slot+1 {
		return nil
	}
	if _, err := s.db.Exec(`INSERT OR IGNORE INTO agent_seen (agent, team, slot) VALUES (?,?,?)`, agent, team, slot); err != nil {
		return err
	}
	s.seen[k] = slot + 1
	return nil
}

func ms(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

func tm(v int64) time.Time {
	if v == 0 {
		return time.Time{}
	}
	return time.UnixMilli(v).UTC()
}

// Begin records a wait that starts now and returns its id.
func (s *Store) Begin(w Wait) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, err := s.db.Exec(`INSERT INTO limit_waits (session_id, agent, team, vendor, started_at, reset_at) VALUES (?,?,?,?,?,?)`, w.SessionID, w.Agent, w.Team, w.Vendor, ms(w.StartedAt), ms(w.ResetAt))
	if err != nil {
		return 0, err
	}
	return r.LastInsertId()
}

// End closes a wait that is still open; one already closed is left as it is.
func (s *Store) End(id int64, at time.Time, kind string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE limit_waits SET ended_at = ?, ended = ? WHERE id = ? AND ended = ''`, ms(at), kind, id)
	return err
}

// Open returns the waits that have not ended: after a restart the counter goes on with them instead of counting an agent that still waits a second time.
func (s *Store) Open() ([]Wait, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`SELECT id, session_id, agent, team, vendor, started_at, reset_at FROM limit_waits WHERE ended = ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Wait
	for rows.Next() {
		var w Wait
		var st, rs int64
		if err := rows.Scan(&w.ID, &w.SessionID, &w.Agent, &w.Team, &w.Vendor, &st, &rs); err != nil {
			return nil, err
		}
		w.StartedAt, w.ResetAt = tm(st), tm(rs)
		out = append(out, w)
	}
	return out, rows.Err()
}

// Totals are the three numbers of the cost page's card.
type Totals struct {
	Waits   int `json:"waits"`
	AtReset int `json:"at_reset"`
	Early   int `json:"early"`
}

// Row is one agent on one day.
type Row struct {
	Agent   string `json:"agent"`
	Day     string `json:"day"` // YYYY-MM-DD in the zone asked for
	Waits   int    `json:"waits"`
	AtReset int    `json:"at_reset"`
	Early   int    `json:"early"`
}

// Report is what the cost page shows for a range.
type Report struct {
	Totals Totals `json:"totals"`
	Rows   []Row  `json:"rows"`
	// Teams are the teams that had a wait in the range, whichever team was asked for: the page's Team select lists them.
	Teams []string `json:"teams"`
	// Waiting is how many of the waits in the range have not ended yet (they are counted as waits and as neither kind of resume until they do).
	Waiting int `json:"waiting"`
}

// Counts reports the waits that STARTED in [from, to), of one team ("" is every team), per agent and day (the day of the wait's start, in loc): a wait, and how it ended, are counted on the day it began.
func (s *Store) Counts(from, to time.Time, team string, loc *time.Location) (Report, error) {
	if loc == nil {
		loc = time.Local
	}
	s.mu.Lock()
	rows, err := s.db.Query(`SELECT agent, team, started_at, ended FROM limit_waits WHERE started_at >= ? AND started_at < ?`, from.UnixMilli(), to.UnixMilli())
	if err != nil {
		s.mu.Unlock()
		return Report{}, err
	}
	type key struct{ agent, day string }
	by := map[key]*Row{}
	rep := Report{Rows: []Row{}, Teams: []string{}}
	teams := map[string]bool{}
	for rows.Next() {
		var agent, rowTeam, ended string
		var st int64
		if err := rows.Scan(&agent, &rowTeam, &st, &ended); err != nil {
			rows.Close()
			s.mu.Unlock()
			return Report{}, err
		}
		if rowTeam != "" {
			teams[rowTeam] = true
		}
		if team != "" && rowTeam != team {
			continue
		}
		k := key{agent, time.UnixMilli(st).In(loc).Format("2006-01-02")}
		r := by[k]
		if r == nil {
			r = &Row{Agent: agent, Day: k.day}
			by[k] = r
		}
		r.Waits++
		rep.Totals.Waits++
		switch ended {
		case EndedAtReset:
			r.AtReset++
			rep.Totals.AtReset++
		case EndedEarly:
			r.Early++
			rep.Totals.Early++
		case "":
			rep.Waiting++
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		s.mu.Unlock()
		return Report{}, err
	}
	// an agent seen on a day that had a wait (in this team's view) is a row of its own, with zeros when it had none
	days := map[string]bool{}
	for k := range by {
		days[k.day] = true
	}
	if len(days) > 0 {
		seen, err := s.db.Query(`SELECT agent, team, slot FROM agent_seen WHERE slot >= ? AND slot < ?`, from.Unix()/seenSlot, (to.Unix()+seenSlot-1)/seenSlot)
		if err != nil {
			s.mu.Unlock()
			return Report{}, err
		}
		for seen.Next() {
			var agent, rowTeam string
			var slot int64
			if err := seen.Scan(&agent, &rowTeam, &slot); err != nil {
				seen.Close()
				s.mu.Unlock()
				return Report{}, err
			}
			t := time.Unix(slot*seenSlot, 0)
			if t.Before(from) || !t.Before(to) {
				continue
			}
			if rowTeam != "" {
				teams[rowTeam] = true
			}
			if team != "" && rowTeam != team {
				continue
			}
			k := key{agent, t.In(loc).Format("2006-01-02")}
			if days[k.day] && by[k] == nil {
				by[k] = &Row{Agent: agent, Day: k.day}
			}
		}
		err = seen.Err()
		seen.Close()
		if err != nil {
			s.mu.Unlock()
			return Report{}, err
		}
	}
	s.mu.Unlock()
	for _, r := range by {
		rep.Rows = append(rep.Rows, *r)
	}
	for t := range teams {
		rep.Teams = append(rep.Teams, t)
	}
	sort.Strings(rep.Teams)
	sort.Slice(rep.Rows, func(i, j int) bool {
		a, b := rep.Rows[i], rep.Rows[j]
		if a.Day != b.Day {
			return a.Day > b.Day
		}
		if a.Waits != b.Waits {
			return a.Waits > b.Waits
		}
		return a.Agent < b.Agent
	})
	return rep, nil
}
