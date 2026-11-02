package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"

	"github.com/subgentic/coral/internal/skills"
)

// Skill statuses.
const (
	SkillPending  = "pending"  // published by an agent: seen only by the Operator
	SkillApproved = "approved" // searchable, attachable, served by get
	SkillRejected = "rejected"
	SkillRemoved  = "removed" // a tombstone: no text, so a pinned agent is told it was removed
)

// Who published a skill.
const (
	PublisherOperator = "operator"
	PublisherAgent    = "agent"
)

// The caps of the Skills Store.
const (
	MaxSkills             = 500
	MaxPendingPerAgent    = 5
	MaxPendingPerComputer = 20
	maxSearchWords        = 8
	maxSearchResults      = 20
)

var (
	// ErrSkillNotFound is a skill that does not exist or that the asker may not see (pending, rejected): the same answer for both.
	ErrSkillNotFound = errors.New("store: no such skill")
	// ErrSkillRemoved is a skill the Operator removed.
	ErrSkillRemoved = errors.New("store: the skill was removed by the Operator")
	// ErrAgentScripts: an agent's skill may hold only SKILL.md and document or data files (.md .txt .json .yaml .yml .csv .toml) in v1.
	ErrAgentScripts = errors.New("store: an agent's skill may hold only SKILL.md and document or data files")
	// ErrPendingCap: too many skills wait for the Operator.
	ErrPendingCap = errors.New("store: too many skills are waiting for the Operator")
	// ErrTooManySkills: the store is full.
	ErrTooManySkills = errors.New("store: too many skills on this computer")
	// ErrNeedScriptsAck: a skill with scripts or files that cannot be shown as text needs the second explicit click.
	ErrNeedScriptsAck = errors.New("store: the scripts must be reviewed and acknowledged first")
	// ErrSkillDigest: the digest the Operator saw is not the one stored.
	ErrSkillDigest = errors.New("store: the skill is not the one that was reviewed")
	// ErrSkillState: the skill is not in a state the action applies to.
	ErrSkillState = errors.New("store: the skill is not waiting for a decision")
	// ErrBadSkill: a digest or publisher that is not valid.
	ErrBadSkill = errors.New("store: not a valid skill record")
)

var skillDigestRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// SkillRow is one version of a skill.
type SkillRow struct {
	ID             string `db:"id" json:"id"`
	Name           string `db:"name" json:"name"`
	Version        int    `db:"version" json:"version"`
	Digest         string `db:"digest" json:"digest"`
	Description    string `db:"description" json:"description"`
	MetadataJSON   string `db:"metadata_json" json:"-"`
	FilesJSON      string `db:"files_json" json:"-"`
	HasScripts     bool   `db:"has_scripts" json:"has_scripts"`
	NotReviewable  bool   `db:"not_reviewable" json:"not_reviewable"`
	Status         string `db:"status" json:"status"`
	PublisherKind  string `db:"publisher_kind" json:"publisher_kind"`
	PublisherAgent string `db:"publisher_agent" json:"publisher_agent"`
	PublisherTeam  string `db:"publisher_team" json:"publisher_team"`
	ScriptsAcked   bool   `db:"scripts_acked" json:"scripts_acked"`
	CreatedAt      string `db:"created_at" json:"created_at"`
	DecidedAt      string `db:"decided_at" json:"decided_at"`
}

// Files are the skill's files with their sizes and kinds.
func (r *SkillRow) Files() []skills.File {
	var out []skills.File
	_ = json.Unmarshal([]byte(r.FilesJSON), &out)
	return out
}

// Metadata is the skill's metadata map.
func (r *SkillRow) Metadata() map[string]string {
	out := map[string]string{}
	_ = json.Unmarshal([]byte(r.MetadataJSON), &out)
	return out
}

// AddSkillInput is a parsed skill and who published it. The publisher comes from the caller's identity (an agent's session token), never from the skill's own text.
type AddSkillInput struct {
	Skill  *skills.Skill
	Digest string // the sha256 (hex) of the zip, which is the artifact's id
	Kind   string // PublisherOperator or PublisherAgent
	Agent  string
	Team   string
	// ScriptsAcked is the Operator's second click on the list of scripts, needed for an Operator's skill that has scripts or files that cannot be shown as text.
	ScriptsAcked bool
}

func skillID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func now() string { return time.Now().UTC().Format(time.RFC3339) }

// AddSkill records one version of a skill. An Operator's skill is approved at once; an agent's waits for the Operator, and an agent cannot publish scripts in v1. The same name and digest again
// returns the row that is there. Caps: 500 skills on a computer, 5 waiting per agent, 20 waiting in all.
func (s *SessionStore) AddSkill(ctx context.Context, in AddSkillInput) (*SkillRow, bool, error) {
	sk := in.Skill
	if sk == nil || !skillDigestRe.MatchString(in.Digest) || (in.Kind != PublisherOperator && in.Kind != PublisherAgent) || (in.Kind == PublisherAgent && in.Agent == "") {
		return nil, false, ErrBadSkill
	}
	if sk.Digest != in.Digest { // the text that is indexed must be the bytes the digest names
		return nil, false, ErrSkillDigest
	}
	risky := sk.Scripts() > 0 || sk.NotReviewable() > 0
	if in.Kind == PublisherAgent && (risky || !skills.AgentMayPublish(sk)) {
		return nil, false, ErrAgentScripts
	}
	if in.Kind == PublisherOperator && risky && !in.ScriptsAcked {
		return nil, false, ErrNeedScriptsAck
	}
	meta, _ := json.Marshal(sk.Metadata)
	files, _ := json.Marshal(sk.Files)
	var out *SkillRow
	created := false
	err := s.db.WithTx(ctx, func(tx *sqlx.Tx) error {
		var existing SkillRow
		err := tx.GetContext(ctx, &existing, `SELECT * FROM skills WHERE name = ? AND digest = ?`, sk.Name, in.Digest)
		if err == nil && existing.Status != SkillRemoved && existing.Status != SkillRejected {
			out = &existing
			return nil
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		var total, pendingAll, pendingAgent int
		if err := tx.GetContext(ctx, &total, `SELECT COUNT(*) FROM skills WHERE status <> ?`, SkillRemoved); err != nil {
			return err
		}
		if total >= MaxSkills {
			return ErrTooManySkills
		}
		status := SkillApproved
		if in.Kind == PublisherAgent {
			status = SkillPending
			if err := tx.GetContext(ctx, &pendingAll, `SELECT COUNT(*) FROM skills WHERE status = ?`, SkillPending); err != nil {
				return err
			}
			if err := tx.GetContext(ctx, &pendingAgent, `SELECT COUNT(*) FROM skills WHERE status = ? AND publisher_kind = ? AND publisher_agent = ?`, SkillPending, PublisherAgent, in.Agent); err != nil {
				return err
			}
			if pendingAll >= MaxPendingPerComputer || pendingAgent >= MaxPendingPerAgent {
				return ErrPendingCap
			}
		}
		var version int
		if err := tx.GetContext(ctx, &version, `SELECT COALESCE(MAX(version), 0) + 1 FROM skills WHERE name = ?`, sk.Name); err != nil {
			return err
		}
		if existing.ID != "" { // the same bytes again after a rejection or a removal: a new version, not a second row with the same digest
			if _, err := tx.ExecContext(ctx, `DELETE FROM skills WHERE id = ?`, existing.ID); err != nil {
				return err
			}
		}
		row := SkillRow{ID: skillID(), Name: sk.Name, Version: version, Digest: in.Digest, Description: sk.Description, MetadataJSON: string(meta), FilesJSON: string(files),
			HasScripts: sk.Scripts() > 0, NotReviewable: sk.NotReviewable() > 0, Status: status, PublisherKind: in.Kind, PublisherAgent: in.Agent, PublisherTeam: in.Team,
			ScriptsAcked: in.Kind == PublisherOperator && in.ScriptsAcked, CreatedAt: now()}
		if status == SkillApproved {
			row.DecidedAt = row.CreatedAt
		}
		if _, err := tx.NamedExecContext(ctx, `INSERT INTO skills (id, name, version, digest, description, metadata_json, files_json, has_scripts, not_reviewable, status, publisher_kind,
			publisher_agent, publisher_team, scripts_acked, created_at, decided_at) VALUES (:id, :name, :version, :digest, :description, :metadata_json, :files_json, :has_scripts, :not_reviewable,
			:status, :publisher_kind, :publisher_agent, :publisher_team, :scripts_acked, :created_at, :decided_at)`, row); err != nil {
			return err
		}
		if err := logSkill(ctx, tx, "publish", row.ID, in.Digest, in.Kind, in.Agent); err != nil {
			return err
		}
		if status == SkillApproved {
			if err := indexSkill(ctx, tx, row.ID, sk); err != nil {
				return err
			}
		}
		out, created = &row, true
		return nil
	})
	if err != nil {
		return nil, false, err
	}
	return out, created, nil
}

func logSkill(ctx context.Context, tx *sqlx.Tx, event, id, digest, kind, actor string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO skills_log (at, event, skill_id, digest, actor_kind, actor) VALUES (?, ?, ?, ?, ?, ?)`, now(), event, id, digest, kind, actor)
	return err
}

func indexSkill(ctx context.Context, tx *sqlx.Tx, id string, sk *skills.Skill) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM skills_fts WHERE skill_id = ?`, id); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO skills_fts (skill_id, name, description, tags, body) VALUES (?, ?, ?, ?, ?)`,
		id, strings.ReplaceAll(sk.Name, "-", " "), sk.Description, strings.Join(sk.Tags(), " "), sk.Body)
	return err
}

// ApproveSkill is the Operator's decision on a pending skill: the digest they were shown must be the stored one, and a skill with scripts or files that cannot be shown as text needs the second
// click (scriptsAcked). The skill's text, which only the caller can read (it is in the artifact), is indexed for search.
func (s *SessionStore) ApproveSkill(ctx context.Context, id, digest string, scriptsAcked bool, sk *skills.Skill) error {
	return s.db.WithTx(ctx, func(tx *sqlx.Tx) error {
		var row SkillRow
		if err := tx.GetContext(ctx, &row, `SELECT * FROM skills WHERE id = ?`, id); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrSkillNotFound
			}
			return err
		}
		if row.Status != SkillPending {
			return ErrSkillState
		}
		if row.Digest != digest || sk == nil || sk.Name != row.Name || sk.Digest != digest {
			return ErrSkillDigest
		}
		if (row.HasScripts || row.NotReviewable) && !scriptsAcked {
			return ErrNeedScriptsAck
		}
		if _, err := tx.ExecContext(ctx, `UPDATE skills SET status = ?, decided_at = ?, scripts_acked = ? WHERE id = ?`, SkillApproved, now(), scriptsAcked, id); err != nil {
			return err
		}
		if err := indexSkill(ctx, tx, id, sk); err != nil {
			return err
		}
		return logSkill(ctx, tx, "approve", id, digest, PublisherOperator, "")
	})
}

// RejectSkill is the Operator's refusal of a pending skill.
func (s *SessionStore) RejectSkill(ctx context.Context, id string) error {
	return s.db.WithTx(ctx, func(tx *sqlx.Tx) error {
		var row SkillRow
		if err := tx.GetContext(ctx, &row, `SELECT * FROM skills WHERE id = ?`, id); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrSkillNotFound
			}
			return err
		}
		if row.Status != SkillPending {
			return ErrSkillState
		}
		if _, err := tx.ExecContext(ctx, `UPDATE skills SET status = ?, decided_at = ? WHERE id = ?`, SkillRejected, now(), id); err != nil {
			return err
		}
		return logSkill(ctx, tx, "reject", id, row.Digest, PublisherOperator, "")
	})
}

// RemoveSkill is the Operator's delete: the text and the search entry go, a tombstone stays so a pinned agent's get says "removed by the Operator".
func (s *SessionStore) RemoveSkill(ctx context.Context, id string) error {
	return s.db.WithTx(ctx, func(tx *sqlx.Tx) error {
		var row SkillRow
		if err := tx.GetContext(ctx, &row, `SELECT * FROM skills WHERE id = ?`, id); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrSkillNotFound
			}
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM skills_fts WHERE skill_id = ?`, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE skills SET status = ?, description = '', metadata_json = '{}', files_json = '[]', decided_at = ? WHERE id = ?`, SkillRemoved, now(), id); err != nil {
			return err
		}
		return logSkill(ctx, tx, "remove", id, row.Digest, PublisherOperator, "")
	})
}

// GetSkill is the Operator's view of any version.
func (s *SessionStore) GetSkill(ctx context.Context, id string) (*SkillRow, error) {
	var row SkillRow
	if err := s.reader().GetContext(ctx, &row, `SELECT * FROM skills WHERE id = ?`, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrSkillNotFound
		}
		return nil, err
	}
	return &row, nil
}

// GetApprovedSkill is what an agent may read: an approved version, checked now, every time. A removed one says so; a pending, rejected or missing one is "no such skill", the same for each.
func (s *SessionStore) GetApprovedSkill(ctx context.Context, id string) (*SkillRow, error) {
	row, err := s.GetSkill(ctx, id)
	if err != nil {
		return nil, err
	}
	switch row.Status {
	case SkillApproved:
		return row, nil
	case SkillRemoved:
		return nil, ErrSkillRemoved
	}
	return nil, ErrSkillNotFound
}

// LatestApprovedSkill is the newest approved version of name.
func (s *SessionStore) LatestApprovedSkill(ctx context.Context, name string) (*SkillRow, error) {
	var row SkillRow
	if err := s.reader().GetContext(ctx, &row, `SELECT * FROM skills WHERE name = ? AND status = ? ORDER BY version DESC LIMIT 1`, name, SkillApproved); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrSkillNotFound
		}
		return nil, err
	}
	return &row, nil
}

// ListSkills is the Operator's list, newest first; status "" is every status but removed.
func (s *SessionStore) ListSkills(ctx context.Context, status string) ([]SkillRow, error) {
	q, args := `SELECT * FROM skills WHERE status <> ? ORDER BY created_at DESC, version DESC, id`, []any{SkillRemoved}
	if status != "" {
		q, args = `SELECT * FROM skills WHERE status = ? ORDER BY created_at DESC, version DESC, id`, []any{status}
	}
	var rows []SkillRow
	if err := s.reader().SelectContext(ctx, &rows, q, args...); err != nil {
		return nil, err
	}
	return rows, nil
}

var searchWordRe = regexp.MustCompile(`[\p{L}\p{N}_-]+`)

// skillMatch makes the FTS5 query of words: each word quoted as one phrase (FTS5's operators, NEAR, columns and prefixes are not the asker's), at most maxSearchWords of them; "" for none.
func skillMatch(words string) string {
	var out []string
	for _, w := range searchWordRe.FindAllString(words, -1) {
		out = append(out, `"`+w+`"`)
		if len(out) == maxSearchWords {
			break
		}
	}
	return strings.Join(out, " ")
}

// SkillHit is one search result.
type SkillHit struct {
	ID            string `db:"id" json:"id"`
	Name          string `db:"name" json:"name"`
	Version       int    `db:"version" json:"version"`
	Description   string `db:"description" json:"description"`
	HasScripts    bool   `db:"has_scripts" json:"has_scripts"`
	NotReviewable bool   `db:"not_reviewable" json:"not_reviewable"`
}

// SearchSkills searches the approved skills: description first, then name, tags, then the text.
func (s *SessionStore) SearchSkills(ctx context.Context, words string, limit int) ([]SkillHit, error) {
	m := skillMatch(words)
	if m == "" {
		return nil, nil
	}
	if limit <= 0 || limit > maxSearchResults {
		limit = maxSearchResults
	}
	var hits []SkillHit
	err := s.reader().SelectContext(ctx, &hits, `SELECT s.id, s.name, s.version, s.description, s.has_scripts, s.not_reviewable FROM skills_fts f JOIN skills s ON s.id = f.skill_id
		WHERE skills_fts MATCH ? AND s.status = ? ORDER BY bm25(skills_fts, 0.0, 4.0, 10.0, 3.0, 1.0), s.version DESC LIMIT ?`, m, SkillApproved, limit)
	return hits, err
}

// The access log is kept 90 days and at most 10,000 rows (the bounds of the search access log).
const (
	skillsLogDays = 90
	skillsLogRows = 10000
)

// LogSkillAccess records that actor (an agent, or the Operator) searched, listed or read a skill. A search names how many results it had, never the words searched.
func (s *SessionStore) LogSkillAccess(ctx context.Context, event, skillID, digest, actorKind, actor, detail string) error {
	return s.db.WithTx(ctx, func(tx *sqlx.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO skills_log (at, event, skill_id, digest, actor_kind, actor, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`, now(), event, skillID, digest, actorKind, actor, detail); err != nil {
			return err
		}
		cutoff := time.Now().UTC().AddDate(0, 0, -skillsLogDays).Format(time.RFC3339)
		_, err := tx.ExecContext(ctx, `DELETE FROM skills_log WHERE at < ? OR id <= (SELECT MAX(id) FROM skills_log) - ?`, cutoff, skillsLogRows)
		return err
	})
}

// SkillLogEntry is one row of the access log.
type SkillLogEntry struct {
	At        string `db:"at" json:"at"`
	Event     string `db:"event" json:"event"`
	SkillID   string `db:"skill_id" json:"skill_id"`
	Digest    string `db:"digest" json:"digest"`
	ActorKind string `db:"actor_kind" json:"actor_kind"`
	Actor     string `db:"actor" json:"actor"`
	Detail    string `db:"detail" json:"detail"`
}

// SkillLog is the newest limit rows of the log, newest first.
func (s *SessionStore) SkillLog(ctx context.Context, limit int) ([]SkillLogEntry, error) {
	if limit <= 0 || limit > 500 {
		limit = 500
	}
	var rows []SkillLogEntry
	err := s.reader().SelectContext(ctx, &rows, `SELECT at, event, skill_id, digest, actor_kind, actor, detail FROM skills_log ORDER BY id DESC LIMIT ?`, limit)
	return rows, err
}

// ListApprovedSkills is the newest approved version of each skill, by name.
func (s *SessionStore) ListApprovedSkills(ctx context.Context) ([]SkillRow, error) {
	var rows []SkillRow
	err := s.reader().SelectContext(ctx, &rows, `SELECT * FROM skills s WHERE status = ? AND version = (SELECT MAX(version) FROM skills WHERE name = s.name AND status = ?) ORDER BY name`, SkillApproved, SkillApproved)
	return rows, err
}
