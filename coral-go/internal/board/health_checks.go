package board

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/healthcheck"
)

// Limits of the custom checks (design v2 section 5.9).
const (
	MaxHealthChecksPerBoard = 10
	MaxHealthCheckKeys      = 100
	HealthCheckFailPause    = 5 // failures in a row that pause a check
	HealthCheckRenag        = 24 * time.Hour
)

// States of a check.
const (
	CheckPending  = "pending"
	CheckApproved = "approved"
	CheckPaused   = "paused"
)

// HealthCheck is one custom check. Nothing in it runs until the Operator approves its record.
type HealthCheck struct {
	ID           int64    `json:"id" db:"id"`
	Project      string   `json:"project" db:"project"`
	Name         string   `json:"name" db:"name"`
	ScriptSrc    string   `json:"script_src" db:"script_src"`
	ScriptHash   string   `json:"script_hash" db:"script_hash"`
	Snapshot     string   `json:"snapshot" db:"snapshot"`
	ArgsJSON     string   `json:"-" db:"args"`
	Args         []string `json:"args" db:"-"`
	Dir          string   `json:"dir" db:"dir"`
	Every        string   `json:"every" db:"every_period"`
	Daily        string   `json:"daily" db:"daily_at"`
	TZ           string   `json:"tz" db:"tz"`
	To           string   `json:"to" db:"to_member"`
	ActsAs       string   `json:"acts_as" db:"acts_as"`
	State        string   `json:"state" db:"state"`
	ApprovedBy   string   `json:"approved_by" db:"approved_by"`
	ApprovedHash string   `json:"approved_record_hash" db:"approved_hash"`
	NextRun      string   `json:"next_run" db:"next_run"`
	LastRun      string   `json:"last_run" db:"last_run"`
	LastExit     int      `json:"last_exit" db:"last_exit"`
	LastOutput   string   `json:"last_output" db:"last_output"`
	BadLines     int      `json:"bad_lines" db:"bad_lines"`
	DroppedTo    int      `json:"dropped_to" db:"dropped_to"`
	Fails        int      `json:"fails" db:"fails"`
	FailSaid     bool     `json:"fail_said" db:"fail_said"`
	CreatedAt    string   `json:"created_at" db:"created_at"`
}

// Schedule is the check's schedule.
func (c HealthCheck) Schedule() healthcheck.Schedule {
	return healthcheck.Schedule{Every: c.Every, Daily: c.Daily, TZ: c.TZ}
}

// Record is what the Operator approves.
func (c HealthCheck) Record() healthcheck.Record {
	return healthcheck.Record{ScriptHash: c.ScriptHash, Args: c.Args, Dir: c.Dir, Every: c.Schedule().String(), To: c.To, ActsAs: c.ActsAs, Env: []string{"CORAL_BOARD", "CORAL_BOARD_URL", "CORAL_CHECK_TOKEN"}}
}

// RecordHash is the hash of the record as it is now.
func (c HealthCheck) RecordHash() string { return c.Record().Hash() }

// Approved says the check may run: approved, and the record is the one that was approved.
func (c HealthCheck) Approved() bool {
	return c.State == CheckApproved && c.ApprovedHash != "" && c.ApprovedHash == c.RecordHash()
}

func (s *Store) ensureHealthChecksSchema(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS health_checks (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	project       TEXT NOT NULL,
	name          TEXT NOT NULL,
	script_src    TEXT NOT NULL DEFAULT '',
	script_hash   TEXT NOT NULL DEFAULT '',
	snapshot      TEXT NOT NULL DEFAULT '',
	args          TEXT NOT NULL DEFAULT '[]',
	dir           TEXT NOT NULL DEFAULT '',
	every_period  TEXT NOT NULL DEFAULT '',
	daily_at      TEXT NOT NULL DEFAULT '',
	tz            TEXT NOT NULL DEFAULT '',
	to_member     TEXT NOT NULL DEFAULT '',
	acts_as       TEXT NOT NULL DEFAULT '',
	state         TEXT NOT NULL DEFAULT 'pending',
	approved_by   TEXT NOT NULL DEFAULT '',
	approved_hash TEXT NOT NULL DEFAULT '',
	next_run      TEXT NOT NULL DEFAULT '',
	last_run      TEXT NOT NULL DEFAULT '',
	last_exit     INTEGER NOT NULL DEFAULT 0,
	last_output   TEXT NOT NULL DEFAULT '',
	bad_lines     INTEGER NOT NULL DEFAULT 0,
	dropped_to    INTEGER NOT NULL DEFAULT 0,
	fails         INTEGER NOT NULL DEFAULT 0,
	fail_said     INTEGER NOT NULL DEFAULT 0,
	created_at    TEXT NOT NULL,
	UNIQUE(project, name)
);
CREATE TABLE IF NOT EXISTS health_check_keys (
	check_id INTEGER NOT NULL,
	key      TEXT NOT NULL,
	said_at  TEXT NOT NULL,
	present  INTEGER NOT NULL DEFAULT 1,
	PRIMARY KEY (check_id, key)
);`)
	return err
}

var (
	ErrCheckExists  = errors.New("a check with that name already exists on this board")
	ErrCheckLimit   = fmt.Errorf("a board has at most %d checks", MaxHealthChecksPerBoard)
	ErrCheckMissing = errors.New("no such check")
	ErrCheckRecord  = errors.New("the check changed since it was shown: look at it again before approving")
)

func (c *HealthCheck) pack() error {
	if c.Args == nil {
		c.Args = []string{}
	}
	b, err := json.Marshal(c.Args)
	c.ArgsJSON = string(b)
	return err
}

func (c *HealthCheck) unpack() {
	c.Args = []string{}
	_ = json.Unmarshal([]byte(c.ArgsJSON), &c.Args)
}

// AddHealthCheck stores a new check, always pending: it needs the Operator's approval before it runs, however it was added.
func (s *Store) AddHealthCheck(ctx context.Context, c HealthCheck, now time.Time) (HealthCheck, error) {
	if !healthcheck.ValidName(c.Name) {
		return c, errors.New("a check's name is lower-case letters, digits and dashes, up to 40 characters")
	}
	if err := c.Schedule().Validate(); err != nil {
		return c, err
	}
	var n int
	if err := s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM health_checks WHERE project = ?`, c.Project); err != nil {
		return c, err
	}
	if n >= MaxHealthChecksPerBoard {
		return c, ErrCheckLimit
	}
	c.State, c.ApprovedBy, c.ApprovedHash, c.NextRun = CheckPending, "", "", ""
	c.CreatedAt = now.UTC().Format(healthTimeFormat)
	if err := c.pack(); err != nil {
		return c, err
	}
	res, err := s.db.ExecContext(ctx, `INSERT INTO health_checks(project, name, script_src, script_hash, snapshot, args, dir, every_period, daily_at, tz, to_member, acts_as, state, created_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, c.Project, c.Name, c.ScriptSrc, c.ScriptHash, c.Snapshot, c.ArgsJSON, c.Dir, c.Every, c.Daily, c.TZ, c.To, c.ActsAs, c.State, c.CreatedAt)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return c, ErrCheckExists
		}
		return c, err
	}
	c.ID, _ = res.LastInsertId()
	return c, nil
}

// GetHealthCheck is one check.
func (s *Store) GetHealthCheck(ctx context.Context, project, name string) (HealthCheck, error) {
	var c HealthCheck
	err := s.db.GetContext(ctx, &c, `SELECT * FROM health_checks WHERE project = ? AND name = ?`, project, name)
	if errors.Is(err, sql.ErrNoRows) {
		return c, ErrCheckMissing
	}
	c.unpack()
	return c, err
}

// ListHealthChecks lists a board's checks by name.
func (s *Store) ListHealthChecks(ctx context.Context, project string) ([]HealthCheck, error) {
	var cs []HealthCheck
	if err := s.db.SelectContext(ctx, &cs, `SELECT * FROM health_checks WHERE project = ? ORDER BY name`, project); err != nil {
		return nil, err
	}
	for i := range cs {
		cs[i].unpack()
	}
	return cs, nil
}

// ApproveHealthCheck is the Operator's approval of the record they were shown (recordHash): it stands only if the check still has that record. The first run is due now.
func (s *Store) ApproveHealthCheck(ctx context.Context, project, name, by, recordHash string, now time.Time) error {
	c, err := s.GetHealthCheck(ctx, project, name)
	if err != nil {
		return err
	}
	if recordHash == "" || c.RecordHash() != recordHash {
		return ErrCheckRecord
	}
	_, err = s.db.ExecContext(ctx, `UPDATE health_checks SET state = ?, approved_by = ?, approved_hash = ?, next_run = ?, fails = 0, fail_said = 0 WHERE id = ?`,
		CheckApproved, by, recordHash, now.UTC().Format(healthTimeFormat), c.ID)
	return err
}

// ChangeHealthCheck changes a check's record (script, arguments, folder, schedule, to, acts as): whatever changes, it is pending again and nothing runs until it is approved.
func (s *Store) ChangeHealthCheck(ctx context.Context, project, name string, change func(*HealthCheck)) (HealthCheck, error) {
	c, err := s.GetHealthCheck(ctx, project, name)
	if err != nil {
		return c, err
	}
	before := c.RecordHash()
	change(&c)
	if err := c.Schedule().Validate(); err != nil {
		return c, err
	}
	if err := c.pack(); err != nil {
		return c, err
	}
	if c.RecordHash() != before {
		c.State, c.ApprovedBy, c.ApprovedHash, c.NextRun = CheckPending, "", "", ""
	}
	_, err = s.db.ExecContext(ctx, `UPDATE health_checks SET script_src = ?, script_hash = ?, snapshot = ?, args = ?, dir = ?, every_period = ?, daily_at = ?, tz = ?, to_member = ?, acts_as = ?,
		state = ?, approved_by = ?, approved_hash = ?, next_run = ? WHERE id = ?`,
		c.ScriptSrc, c.ScriptHash, c.Snapshot, c.ArgsJSON, c.Dir, c.Every, c.Daily, c.TZ, c.To, c.ActsAs, c.State, c.ApprovedBy, c.ApprovedHash, c.NextRun, c.ID)
	return c, err
}

// PauseHealthCheck pauses a check; resume returns it to approved only if its record is still the approved one, else pending.
func (s *Store) PauseHealthCheck(ctx context.Context, project, name string, paused bool, now time.Time) error {
	c, err := s.GetHealthCheck(ctx, project, name)
	if err != nil {
		return err
	}
	state := CheckPaused
	if !paused {
		state = CheckPending
		if c.ApprovedHash != "" && c.ApprovedHash == c.RecordHash() {
			state = CheckApproved
		}
	}
	return s.setCheckState(ctx, c.ID, state, now, paused)
}

func (s *Store) setCheckState(ctx context.Context, id int64, state string, now time.Time, paused bool) error {
	q := `UPDATE health_checks SET state = ?, fails = CASE WHEN ? THEN fails ELSE 0 END, fail_said = CASE WHEN ? THEN fail_said ELSE 0 END WHERE id = ?`
	_, err := s.db.ExecContext(ctx, q, state, paused, paused, id)
	if err == nil && state == CheckApproved {
		_, err = s.db.ExecContext(ctx, `UPDATE health_checks SET next_run = ? WHERE id = ?`, now.UTC().Format(healthTimeFormat), id)
	}
	return err
}

// RemoveHealthCheck deletes a check and its keys.
func (s *Store) RemoveHealthCheck(ctx context.Context, project, name string) error {
	c, err := s.GetHealthCheck(ctx, project, name)
	if err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM health_check_keys WHERE check_id = ?`, c.ID); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `DELETE FROM health_checks WHERE id = ?`, c.ID)
	return err
}

// DueHealthChecks are the approved checks whose time has come, on every board. A check whose record no longer matches its approval is never due.
func (s *Store) DueHealthChecks(ctx context.Context, now time.Time) ([]HealthCheck, error) {
	var cs []HealthCheck
	if err := s.db.SelectContext(ctx, &cs, `SELECT * FROM health_checks WHERE state = ? AND next_run != '' AND next_run <= ? ORDER BY next_run`, CheckApproved, now.UTC().Format(healthTimeFormat)); err != nil {
		return nil, err
	}
	out := cs[:0]
	for _, c := range cs {
		c.unpack()
		if c.Approved() {
			out = append(out, c)
		}
	}
	return out, nil
}

// HealthCheckRun is what a run left.
type HealthCheckRun struct {
	At        time.Time
	Exit      int
	Output    string // redacted and capped by the caller
	Bad       int
	DroppedTo int
	Failed    bool
}

// RecordHealthCheckRun saves a run and sets the next one. It decides from the row as it is NOW, in one transaction, never from the copy the run started with: a pause, a change or a removal made while
// the run was going stays. sayFailure is true the first time a check fails after it was well ("Check <name> failed" is said once until it recovers); paused is true when the failures reached
// HealthCheckFailPause in a row and this run paused the check (a check already paused or pending is not touched).
func (s *Store) RecordHealthCheckRun(ctx context.Context, c HealthCheck, r HealthCheckRun) (sayFailure, paused bool, err error) {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return false, false, err
	}
	defer tx.Rollback()
	var cur struct {
		State string `db:"state"`
		Fails int    `db:"fails"`
		Said  bool   `db:"fail_said"`
	}
	if err := tx.GetContext(ctx, &cur, `SELECT state, fails, fail_said FROM health_checks WHERE id = ?`, c.ID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, false, nil // removed while it ran
		}
		return false, false, err
	}
	fails, said := 0, false
	if r.Failed {
		fails, said = cur.Fails+1, cur.Said
		if !said {
			sayFailure, said = true, true
		}
	}
	state := cur.State
	if fails >= HealthCheckFailPause && cur.State == CheckApproved {
		state, paused = CheckPaused, true
	}
	at := r.At.UTC().Format(healthTimeFormat)
	next := c.Schedule().Next(r.At).UTC().Format(healthTimeFormat)
	if _, err = tx.ExecContext(ctx, `UPDATE health_checks SET last_run = ?, last_exit = ?, last_output = ?, bad_lines = ?, dropped_to = dropped_to + ?, fails = ?, fail_said = ?, state = ?, next_run = CASE WHEN state = ? THEN ? ELSE next_run END WHERE id = ?`,
		at, r.Exit, r.Output, r.Bad, r.DroppedTo, fails, said, state, CheckApproved, next, c.ID); err != nil {
		return false, false, err
	}
	return sayFailure, paused, tx.Commit()
}

// NoteHealthCheckKeys is the once-per-key dedupe: it returns the keys to say now: those not said before, those that were absent from the last run and came back, and those last said over renag ago
// (renag 0 never repeats). A key that is not in keys is marked absent. At most MaxHealthCheckKeys are kept; a key over the cap is not said. A key belongs to its own check: another check's keys are not seen.
func (s *Store) NoteHealthCheckKeys(ctx context.Context, checkID int64, keys []string, now time.Time, renag time.Duration) (fresh []string, err error) {
	at := now.UTC().Format(healthTimeFormat)
	type row struct {
		Key     string `db:"key"`
		SaidAt  string `db:"said_at"`
		Present int    `db:"present"`
	}
	var rows []row
	if err := s.db.SelectContext(ctx, &rows, `SELECT key, said_at, present FROM health_check_keys WHERE check_id = ?`, checkID); err != nil {
		return nil, err
	}
	have := map[string]row{}
	for _, r := range rows {
		have[r.Key] = r
	}
	now2 := map[string]bool{}
	for _, k := range keys {
		if now2[k] {
			continue
		}
		now2[k] = true
		r, known := have[k]
		switch {
		case !known:
			if len(have) >= MaxHealthCheckKeys {
				continue
			}
			have[k] = row{Key: k}
			if _, err := s.db.ExecContext(ctx, `INSERT INTO health_check_keys(check_id, key, said_at, present) VALUES (?,?,?,1)`, checkID, k, at); err != nil {
				return nil, err
			}
			fresh = append(fresh, k)
		case r.Present == 0:
			if _, err := s.db.ExecContext(ctx, `UPDATE health_check_keys SET said_at = ?, present = 1 WHERE check_id = ? AND key = ?`, at, checkID, k); err != nil {
				return nil, err
			}
			fresh = append(fresh, k)
		case renag > 0:
			if t, perr := time.Parse(healthTimeFormat, r.SaidAt); perr == nil && now.Sub(t) >= renag {
				if _, err := s.db.ExecContext(ctx, `UPDATE health_check_keys SET said_at = ? WHERE check_id = ? AND key = ?`, at, checkID, k); err != nil {
					return nil, err
				}
				fresh = append(fresh, k)
			}
		}
	}
	for k, r := range have {
		if !now2[k] && r.Present == 1 {
			if _, err := s.db.ExecContext(ctx, `UPDATE health_check_keys SET present = 0 WHERE check_id = ? AND key = ?`, checkID, k); err != nil {
				return nil, err
			}
		}
	}
	// Absent keys over the cap make room: the oldest go first.
	if _, err := s.db.ExecContext(ctx, `DELETE FROM health_check_keys WHERE check_id = ? AND present = 0 AND key NOT IN (SELECT key FROM health_check_keys WHERE check_id = ? AND present = 0 ORDER BY said_at DESC LIMIT ?)`,
		checkID, checkID, MaxHealthCheckKeys); err != nil {
		return nil, err
	}
	return fresh, nil
}

// Delivery limits of a custom check (Security on #20135, 4a): at most 6 lines to members per check per hour, counted across keys, and 20 a day to one member from all checks. The counts sit in
// health_actions under a rule that ends in -msg, so they never use up the budgets of the built-in rules.
const (
	CheckLinesPerHour = 6
	CheckLinesPerDay  = 20
)

// Why a delivery of a check's line was refused.
const (
	CheckRefusedHour = "check hourly limit"
	CheckRefusedDay  = "member daily limit"
)

func checkActionRule(name string) string { return "check:" + name + "-msg" }

// TakeCheckDelivery counts one line of the check to member and says why it may not go ("" when it may). A refused line is not counted.
func (s *Store) TakeCheckDelivery(ctx context.Context, project, check, member string, now time.Time) (string, error) {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	rule := checkActionRule(check)
	var n int
	if err := tx.GetContext(ctx, &n, `SELECT COUNT(*) FROM health_actions WHERE project = ? AND rule = ? AND at > ?`, project, rule, now.Add(-time.Hour).UTC().Format(healthTimeFormat)); err != nil {
		return "", err
	}
	if n >= CheckLinesPerHour {
		return CheckRefusedHour, nil
	}
	if err := tx.GetContext(ctx, &n, `SELECT COUNT(*) FROM health_actions WHERE project = ? AND rule LIKE 'check:%-msg' AND target = ? AND at > ?`, project, member, now.Add(-24*time.Hour).UTC().Format(healthTimeFormat)); err != nil {
		return "", err
	}
	if n >= CheckLinesPerDay {
		return CheckRefusedDay, nil
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO health_actions(project, rule, target, at) VALUES (?, ?, ?, ?)`, project, rule, member, now.UTC().Format(healthTimeFormat)); err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM health_actions WHERE project = ? AND at < ?`, project, now.Add(-24*time.Hour).UTC().Format(healthTimeFormat)); err != nil {
		return "", err
	}
	return "", tx.Commit()
}
