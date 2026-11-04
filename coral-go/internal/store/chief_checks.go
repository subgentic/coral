package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const MaxChiefChecks = 100
const MaxChiefTriggers = 10000

var ErrChiefConflict = errors.New("check revision changed")
var ErrChiefCapacity = errors.New("check history capacity reached")
var ErrChiefNotFound = errors.New("check not found")

// ChiefCheck contains instructions only: connector credentials/configuration have no fields.
type ChiefCheck struct {
	ID            int64  `db:"id" json:"id"`
	JobID         int64  `db:"job_id" json:"job_id"`
	Revision      int64  `db:"revision" json:"revision"`
	Name          string `db:"name" json:"name"`
	Instruction   string `db:"instruction" json:"instruction"`
	TargetBoard   string `db:"target_board" json:"target_board"`
	TargetSession string `db:"target_session" json:"target_session"`
	NotifyMode    string `db:"notify_mode" json:"notify_mode"`
	SourceKey     string `db:"source_key" json:"source_key"`
	WakeIfAsleep  bool   `db:"wake_if_asleep" json:"wake_if_asleep"`
	Enabled       bool   `db:"enabled" json:"enabled"`
	PausedReason  string `db:"paused_reason" json:"paused_reason,omitempty"`
	ScheduleKind  string `db:"schedule_kind" json:"schedule_kind"`
	EveryMinutes  int    `db:"every_minutes" json:"every_minutes"`
	At            string `db:"at_time" json:"at"`
	Timezone      string `db:"timezone" json:"timezone"`
	Deleted       bool   `db:"deleted" json:"-"`
}

// ChiefCron produces only the supported five-field schedules, never approximations.
func ChiefCron(c ChiefCheck) (string, error) {
	if strings.TrimSpace(c.Name) == "" || utf8.RuneCountInString(c.Name) > 120 || strings.TrimSpace(c.Instruction) == "" || len(c.Instruction) > 8192 || len(c.SourceKey) > 120 || c.TargetBoard == "" || c.TargetSession == "" {
		return "", errors.New("invalid check fields")
	}
	if c.NotifyMode != "only_if_found" && c.NotifyMode != "every_time" && c.NotifyMode != "daily_brief" {
		return "", errors.New("invalid notify mode")
	}
	if c.Timezone == "" || c.Timezone == "Local" {
		return "", errors.New("timezone is required")
	}
	if _, err := time.LoadLocation(c.Timezone); err != nil {
		return "", errors.New("invalid timezone")
	}
	if c.ScheduleKind == "interval" {
		switch c.EveryMinutes {
		case 5, 15, 30:
			return fmt.Sprintf("*/%d * * * *", c.EveryMinutes), nil
		case 60:
			return "0 * * * *", nil
		default:
			return "", errors.New("interval must be 5, 15, 30 or 60 minutes")
		}
	}
	if c.ScheduleKind != "daily" && c.ScheduleKind != "weekdays" {
		return "", errors.New("invalid schedule")
	}
	at, err := time.Parse("15:04", c.At)
	if err != nil || at.Format("15:04") != c.At {
		return "", errors.New("time must be HH:mm")
	}
	days := "*"
	if c.ScheduleKind == "weekdays" {
		days = "1-5"
	}
	return fmt.Sprintf("%d %d * * %s", at.Minute(), at.Hour(), days), nil
}

const chiefCheckCols = `c.id,c.job_id,c.revision,c.name,c.instruction,c.target_board,c.target_session,c.notify_mode,c.source_key,c.wake_if_asleep,j.enabled,j.paused_reason,c.schedule_kind,c.every_minutes,c.at_time,j.timezone,c.deleted`

func (s *ScheduleStore) ChiefCheck(ctx context.Context, id int64) (*ChiefCheck, error) {
	var c ChiefCheck
	err := s.db.GetContext(ctx, &c, `SELECT `+chiefCheckCols+` FROM chief_checks c JOIN scheduled_jobs j ON j.id=c.job_id WHERE c.id=?`, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrChiefNotFound
	}
	return &c, err
}
func (s *ScheduleStore) ChiefCheckForJob(ctx context.Context, id int64) (*ChiefCheck, error) {
	var c ChiefCheck
	err := s.db.GetContext(ctx, &c, `SELECT `+chiefCheckCols+` FROM chief_checks c JOIN scheduled_jobs j ON j.id=c.job_id WHERE c.job_id=?`, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrChiefNotFound
	}
	return &c, err
}
func (s *ScheduleStore) ChiefChecks(ctx context.Context) ([]ChiefCheck, error) {
	out := []ChiefCheck{}
	err := s.db.SelectContext(ctx, &out, `SELECT `+chiefCheckCols+` FROM chief_checks c JOIN scheduled_jobs j ON j.id=c.job_id WHERE c.deleted=0 ORDER BY c.id`)
	return out, err
}

func (s *ScheduleStore) SaveChiefCheck(ctx context.Context, c ChiefCheck) (*ChiefCheck, error) {
	cron, err := ChiefCron(c)
	if err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	now := nowUTC()
	if c.ID == 0 {
		// Drop deleted definitions only when no trigger needs their history.
		if _, err = tx.ExecContext(ctx, `DELETE FROM chief_checks WHERE deleted=1 AND NOT EXISTS(SELECT 1 FROM chief_triggers t WHERE t.check_id=chief_checks.id)`); err != nil {
			return nil, err
		}
		if _, err = tx.ExecContext(ctx, `DELETE FROM scheduled_jobs WHERE job_type='check' AND NOT EXISTS(SELECT 1 FROM chief_checks c WHERE c.job_id=scheduled_jobs.id)`); err != nil {
			return nil, err
		}
		var n int
		if err = tx.GetContext(ctx, &n, `SELECT COUNT(*) FROM chief_checks`); err != nil {
			return nil, err
		}
		if n >= MaxChiefChecks {
			return nil, ErrChiefCapacity
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO scheduled_jobs(name,cron_expr,timezone,agent_type,repo_path,prompt,enabled,no_worktree,cleanup_worktree,job_type,created_at,updated_at) VALUES(?,?,?,'','',?,?,1,0,'check',?,?)`, c.Name, cron, c.Timezone, "", c.Enabled, now, now)
		if err != nil {
			return nil, err
		}
		c.JobID, _ = res.LastInsertId()
		res, err = tx.ExecContext(ctx, `INSERT INTO chief_checks(job_id,revision,name,instruction,target_board,target_session,notify_mode,source_key,wake_if_asleep,schedule_kind,every_minutes,at_time) VALUES(?,1,?,?,?,?,?,?,?,?,?,?)`, c.JobID, c.Name, c.Instruction, c.TargetBoard, c.TargetSession, c.NotifyMode, c.SourceKey, c.WakeIfAsleep, c.ScheduleKind, c.EveryMinutes, c.At)
		if err != nil {
			return nil, err
		}
		c.ID, _ = res.LastInsertId()
	} else {
		res, err := tx.ExecContext(ctx, `UPDATE chief_checks SET revision=revision+1,name=?,instruction=?,target_board=?,target_session=?,notify_mode=?,source_key=?,wake_if_asleep=?,schedule_kind=?,every_minutes=?,at_time=? WHERE id=? AND revision=? AND deleted=0`, c.Name, c.Instruction, c.TargetBoard, c.TargetSession, c.NotifyMode, c.SourceKey, c.WakeIfAsleep, c.ScheduleKind, c.EveryMinutes, c.At, c.ID, c.Revision)
		if err != nil {
			return nil, err
		}
		n, _ := res.RowsAffected()
		if n != 1 {
			return nil, ErrChiefConflict
		}
		var jid int64
		if err = tx.GetContext(ctx, &jid, `SELECT job_id FROM chief_checks WHERE id=?`, c.ID); err != nil {
			return nil, err
		}
		_, err = tx.ExecContext(ctx, `UPDATE scheduled_jobs SET name=?,cron_expr=?,timezone=?,enabled=?,updated_at=?,paused_reason='',resumed_at=CASE WHEN ? THEN ? ELSE resumed_at END WHERE id=?`, c.Name, cron, c.Timezone, c.Enabled, now, c.Enabled, now, jid)
		if err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return s.ChiefCheck(ctx, c.ID)
}
func (s *ScheduleStore) DeleteChiefCheck(ctx context.Context, id, revision int64) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `UPDATE chief_checks SET deleted=1,revision=revision+1 WHERE id=? AND revision=? AND deleted=0`, id, revision)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		return ErrChiefConflict
	}
	_, err = tx.ExecContext(ctx, `UPDATE scheduled_jobs SET enabled=0,updated_at=? WHERE id=(SELECT job_id FROM chief_checks WHERE id=?)`, nowUTC(), id)
	if err != nil {
		return err
	}
	return tx.Commit()
}

type ChiefTrigger struct {
	DeliveryKey   string `db:"delivery_key" json:"-"`
	ID            int64  `db:"id" json:"id"`
	CheckID       int64  `db:"check_id" json:"check_id"`
	RunID         int64  `db:"run_id" json:"run_id"`
	CheckName     string `db:"check_name" json:"check_name"`
	Instruction   string `db:"instruction" json:"-"`
	TargetBoard   string `db:"target_board" json:"target_board"`
	TargetSession string `db:"target_session" json:"target_session"`
	NotifyMode    string `db:"notify_mode" json:"notify_mode"`
	WakeIfAsleep  bool   `db:"wake_if_asleep" json:"wake_if_asleep"`
	State         string `db:"state" json:"state"`
	Delivery      string `db:"delivery" json:"delivery"`
	DeliveryError string `db:"delivery_error" json:"delivery_error"`
	Reminder      string `db:"reminder" json:"reminder"`
	ReminderError string `db:"reminder_error" json:"reminder_error"`
	MessageID     int64  `db:"message_id" json:"message_id"`
	Summary       string `db:"summary" json:"summary"`
	TaskID        int64  `db:"task_id" json:"task_id,omitempty"`
	AskID         int64  `db:"ask_id" json:"ask_id,omitempty"`
	BriefID       int64  `db:"brief_id" json:"brief_id,omitempty"`
	CreatedAt     int64  `db:"created_at" json:"created_at"`
	UpdatedAt     int64  `db:"updated_at" json:"updated_at"`
	RemindedAt    int64  `db:"reminded_at" json:"reminded_at"`
	LeaseUntil    int64  `db:"lease_until" json:"-"`
}

func (s *ScheduleStore) ChiefTrigger(ctx context.Context, id int64) (*ChiefTrigger, error) {
	var t ChiefTrigger
	err := s.db.GetContext(ctx, &t, `SELECT * FROM chief_triggers WHERE id=?`, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrChiefNotFound
	}
	return &t, err
}
func (s *ScheduleStore) ChiefTriggers(ctx context.Context, checkID, before int64, state string) ([]ChiefTrigger, error) {
	q := `SELECT * FROM chief_triggers WHERE 1=1`
	args := []any{}
	if checkID > 0 {
		q += ` AND check_id=?`
		args = append(args, checkID)
	}
	if before > 0 {
		q += ` AND id<?`
		args = append(args, before)
	}
	if state != "" {
		q += ` AND state=?`
		args = append(args, state)
	}
	q += ` ORDER BY id DESC LIMIT 100`
	out := []ChiefTrigger{}
	err := s.db.SelectContext(ctx, &out, q, args...)
	return out, err
}

// BeginChiefTrigger snapshots a check once; its row is also the durable outbox.
// An unresolved trigger coalesces later slots, and manual retry keys survive restart.
func (s *ScheduleStore) BeginChiefTrigger(ctx context.Context, checkID, runID int64, key string, now time.Time) (*ChiefTrigger, error) {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var prior int64
	if key != "" {
		err = tx.GetContext(ctx, &prior, `SELECT trigger_id FROM chief_run_keys WHERE check_id=? AND request_key=?`, checkID, key)
		if err == nil {
			tx.Rollback()
			return s.ChiefTrigger(ctx, prior)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
	}
	err = tx.GetContext(ctx, &prior, `SELECT id FROM chief_triggers WHERE check_id=? AND state!='done' ORDER BY id DESC LIMIT 1`, checkID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if prior == 0 {
		// Keep unresolved rows. A full store fails visibly rather than losing work.
		_, err = tx.ExecContext(ctx, `DELETE FROM chief_run_keys WHERE trigger_id IN (SELECT id FROM chief_triggers WHERE state='done' AND updated_at<?)`, now.Add(-30*24*time.Hour).Unix())
		if err != nil {
			return nil, err
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM chief_triggers WHERE state='done' AND updated_at<?`, now.Add(-30*24*time.Hour).Unix())
		if err != nil {
			return nil, err
		}
		var n int
		if err = tx.GetContext(ctx, &n, `SELECT COUNT(*) FROM chief_triggers`); err != nil {
			return nil, err
		}
		if n >= MaxChiefTriggers {
			var oldest int64
			if err = tx.GetContext(ctx, &oldest, `SELECT id FROM chief_triggers WHERE state='done' ORDER BY updated_at,id LIMIT 1`); err != nil {
				if errors.Is(err, sql.ErrNoRows) {
					return nil, ErrChiefCapacity
				}
				return nil, err
			}
			if _, err = tx.ExecContext(ctx, `DELETE FROM chief_run_keys WHERE trigger_id=?`, oldest); err != nil {
				return nil, err
			}
			if _, err = tx.ExecContext(ctx, `DELETE FROM chief_triggers WHERE id=? AND state='done'`, oldest); err != nil {
				return nil, err
			}
		}
		var c ChiefCheck
		err = tx.GetContext(ctx, &c, `SELECT `+chiefCheckCols+` FROM chief_checks c JOIN scheduled_jobs j ON j.id=c.job_id WHERE c.id=? AND c.deleted=0`, checkID)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrChiefNotFound
		}
		if err != nil {
			return nil, err
		}
		var deliveryBytes [16]byte
		if _, err = rand.Read(deliveryBytes[:]); err != nil {
			return nil, err
		}
		deliveryKey := hex.EncodeToString(deliveryBytes[:])
		res, err := tx.ExecContext(ctx, `INSERT INTO chief_triggers(check_id,run_id,delivery_key,check_name,instruction,target_board,target_session,notify_mode,wake_if_asleep,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, c.ID, runID, deliveryKey, c.Name, c.Instruction, c.TargetBoard, c.TargetSession, c.NotifyMode, c.WakeIfAsleep, now.Unix(), now.Unix())
		if err != nil {
			return nil, err
		}
		prior, _ = res.LastInsertId()
	}
	if runID > 0 {
		if _, err = tx.ExecContext(ctx, `UPDATE chief_triggers SET run_id=? WHERE id=? AND run_id=0`, runID, prior); err != nil {
			return nil, err
		}
	}
	if key != "" {
		var keyCount int
		if err = tx.GetContext(ctx, &keyCount, `SELECT COUNT(*) FROM chief_run_keys`); err != nil {
			return nil, err
		}
		if keyCount >= MaxChiefTriggers*2 {
			return nil, ErrChiefCapacity
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO chief_run_keys(check_id,request_key,trigger_id) VALUES(?,?,?)`, checkID, key, prior)
		if err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return s.ChiefTrigger(ctx, prior)
}
func (s *ScheduleStore) UpdateChiefTriggerState(ctx context.Context, id int64, state, summary string, taskID, askID, briefID int64, now time.Time) error {
	if state != "open" && state != "routed" && state != "waiting_on_operator" && state != "done" {
		return errors.New("invalid trigger state")
	}
	if len(summary) > 2048 {
		return errors.New("summary too long")
	}
	res, err := s.db.ExecContext(ctx, `UPDATE chief_triggers SET state=?,summary=?,task_id=?,ask_id=?,brief_id=?,updated_at=? WHERE id=?`, state, summary, taskID, askID, briefID, now.Unix(), id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		return ErrChiefNotFound
	}
	return nil
}

// SetChiefTriggerResolution changes only the person's resolution state. The
// report and its links belong to the agent and must survive an older UI snapshot.
func (s *ScheduleStore) SetChiefTriggerResolution(ctx context.Context, id int64, state string, now time.Time) error {
	if state != "open" && state != "done" {
		return errors.New("invalid resolution state")
	}
	res, err := s.db.ExecContext(ctx, `UPDATE chief_triggers SET state=?,updated_at=? WHERE id=?`, state, now.Unix(), id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrChiefNotFound
	}
	return nil
}

func (s *ScheduleStore) ChiefPendingDelivery(ctx context.Context, now time.Time) ([]ChiefTrigger, error) {
	out := []ChiefTrigger{}
	err := s.db.SelectContext(ctx, &out, `SELECT * FROM chief_triggers WHERE state!='done' AND lease_until<=? AND (delivery IN ('pending','held') OR (delivery='delivered' AND state='open' AND reminder IN ('none','held') AND created_at<=?)) ORDER BY id LIMIT 100`, now.Unix(), now.Add(-15*time.Minute).Unix())
	return out, err
}
func (s *ScheduleStore) ClaimChiefDelivery(ctx context.Context, id int64, kind string, now time.Time) (bool, error) {
	col := "delivery"
	if kind == "reminder" {
		col = "reminder"
	} else if kind != "delivery" {
		return false, errors.New("invalid delivery kind")
	}
	want := ` IN ('pending','held')`
	if kind == "reminder" {
		want = ` IN ('none','held') AND state='open' AND delivery='delivered' AND created_at<=` + strconv.FormatInt(now.Add(-15*time.Minute).Unix(), 10)
	}
	res, err := s.db.ExecContext(ctx, `UPDATE chief_triggers SET lease_until=? WHERE id=? AND state!='done' AND lease_until<=? AND `+col+want, now.Add(time.Minute).Unix(), id, now.Unix())
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}
func (s *ScheduleStore) FinishChiefDelivery(ctx context.Context, id int64, kind, state, code string, msgID int64, now time.Time) error {
	if state != "delivered" && state != "held" && state != "failed" {
		return errors.New("invalid delivery state")
	}
	if kind == "reminder" {
		_, err := s.db.ExecContext(ctx, `UPDATE chief_triggers SET reminder=?,reminder_error=?,reminded_at=?,lease_until=0,updated_at=? WHERE id=?`, state, code, now.Unix(), now.Unix(), id)
		return err
	}
	if kind != "delivery" {
		return errors.New("invalid delivery kind")
	}
	_, err := s.db.ExecContext(ctx, `UPDATE chief_triggers SET delivery=?,delivery_error=?,message_id=?,lease_until=0,updated_at=? WHERE id=?`, state, code, msgID, now.Unix(), id)
	return err
}

func (s *ScheduleStore) PruneChiefHistory(ctx context.Context, now time.Time) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	cut := now.Add(-30 * 24 * time.Hour).Unix()
	for _, q := range []string{
		`DELETE FROM chief_run_keys WHERE trigger_id IN (SELECT id FROM chief_triggers WHERE state='done' AND updated_at<?)`,
		`DELETE FROM chief_triggers WHERE state='done' AND updated_at<?`,
	} {
		if _, err = tx.ExecContext(ctx, q, cut); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM chief_checks WHERE deleted=1 AND NOT EXISTS(SELECT 1 FROM chief_triggers t WHERE t.check_id=chief_checks.id)`); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM scheduled_jobs WHERE job_type='check' AND NOT EXISTS(SELECT 1 FROM chief_checks c WHERE c.job_id=scheduled_jobs.id)`); err != nil {
		return err
	}
	return tx.Commit()
}
