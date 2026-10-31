package board

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/subgentic/coral/internal/clitext"
)

// The guide role's board half (#11457): a guide is a person the Operator invited to one board through Coral Hub. Their messages are stored as their own origin, under their hub label, with the roster's name
// for them in the text agents read; the manager's roster says which name goes with which label.

// OriginHubGuide marks a message a guide wrote through the tunnel.
const OriginHubGuide = "hub_guide"

// settingGuideRoster is the board_settings key of the roster: a JSON object of hub label to display name.
const settingGuideRoster = "guide_roster"

// MaxGuideRoster is the most guides a roster names; MaxGuideName is the longest display name.
const (
	MaxGuideRoster = 20
	MaxGuideName   = 40
)

var (
	guideLabelRe = regexp.MustCompile(`^hub-user-[0-9a-f]{8}$`)
	// A name that looks like an email address, a link or a mention is not a display name: the roster goes into agents' prompts, and a name is not a way to carry an address or a call to someone.
	guideNameBad = regexp.MustCompile(`[@<>]|://|www\.`)
)

// ErrGuideRoster is a roster that is not acceptable: the message says which entry and why.
var ErrGuideRoster = errors.New("the guide roster is not valid")

// CleanGuideName returns the display name as it may be stored: cleaned of terminal control, trimmed, one line, at most MaxGuideName characters, and "" when what is left is not a name.
func CleanGuideName(s string) string {
	s = strings.Join(strings.Fields(clitext.CleanName(s)), " ")
	if r := []rune(s); len(r) > MaxGuideName {
		s = strings.TrimSpace(string(r[:MaxGuideName]))
	}
	if s == "" || guideNameBad.MatchString(s) || IsOperatorName(s) {
		return ""
	}
	return s
}

// ValidGuideLabel reports whether s is a hub label (hub-user-<8 hex>).
func ValidGuideLabel(s string) bool { return guideLabelRe.MatchString(s) }

// GetGuideRoster returns the roster of a board: label to name (an empty map when none is kept). A stored entry that is not valid any more is left out.
func (s *Store) GetGuideRoster(ctx context.Context, project string) (map[string]string, error) {
	var raw string
	err := s.db.GetContext(ctx, &raw, `SELECT value FROM board_settings WHERE project = ? AND key = ?`, project, settingGuideRoster)
	out := map[string]string{}
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return out, nil
		}
		return nil, err
	}
	var stored map[string]string
	if json.Unmarshal([]byte(raw), &stored) != nil {
		return out, nil
	}
	for label, name := range stored {
		if n := CleanGuideName(name); ValidGuideLabel(label) && n != "" {
			out[label] = n
		}
	}
	return out, nil
}

// SetGuideRoster replaces the roster whole. The caller has decided who may write it (the Operator or the Hub owner). Every entry must be a label and a name that CleanGuideName keeps unchanged.
func (s *Store) SetGuideRoster(ctx context.Context, project string, roster map[string]string) (map[string]string, error) {
	if len(roster) > MaxGuideRoster {
		return nil, fmt.Errorf("%w: at most %d guides", ErrGuideRoster, MaxGuideRoster)
	}
	clean := make(map[string]string, len(roster))
	for label, name := range roster {
		if !ValidGuideLabel(label) {
			return nil, fmt.Errorf("%w: %q is not a guide's label (hub-user- and 8 hex digits)", ErrGuideRoster, shortLabel(label))
		}
		n := CleanGuideName(name)
		if n == "" {
			return nil, fmt.Errorf("%w: the name for %s is empty or not a name (no @, link or address; at most %d characters)", ErrGuideRoster, label, MaxGuideName)
		}
		if taken, err := s.guideNameTaken(ctx, project, n); err != nil {
			return nil, err
		} else if taken {
			return nil, fmt.Errorf("%w: the name for %s is a member's id or job title on this board", ErrGuideRoster, label)
		}
		clean[label] = n
	}
	b, err := json.Marshal(clean)
	if err != nil {
		return nil, err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO board_settings (project, key, value) VALUES (?, ?, ?) ON CONFLICT (project, key) DO UPDATE SET value = excluded.value`, project, settingGuideRoster, string(b))
	return clean, err
}

// RejectGuideProposals declines every proposal a guide's label left waiting on a board (the grant ended): one statement, idempotent, and it returns how many it took back. Approved ones stay: the
// Operator decided them.
func (s *Store) RejectGuideProposals(ctx context.Context, project, label string) (int64, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE board_proposals SET state = 'rejected', reason = ?, decided_at = ? WHERE board_id = ? AND proposer = ? AND state = 'pending'`,
		"the guide's access to this team ended", nowUTC(), project, label)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// GuideName is the name the roster gives a label, or "a guide" when it names none.
func GuideName(roster map[string]string, label string) string {
	if n := roster[label]; n != "" {
		return n
	}
	return "a guide"
}

// PostGuideMessage stores a guide's message: sender and hub user are the label, the origin is hub_guide. The caller has put the guide's own prefix in the text and cleaned it.
func (s *Store) PostGuideMessage(ctx context.Context, project, label, content string) (*Message, error) {
	return s.postMessage(ctx, project, label, content, nil, OriginHubGuide, label, false, nil)
}

// GuideMessage is what a guide reads of a board's message: a closed projection (these fields and no others), so a column added to a message later never reaches a guide by itself. It leaves out the
// project, the session, the group, the cross-team envelope, the Hub user and the task a message answers.
type GuideMessage struct {
	ID           int64   `db:"id" json:"id"`
	SubscriberID string  `db:"subscriber_id" json:"subscriber_id"`
	JobTitle     string  `db:"job_title" json:"job_title,omitempty"`
	Content      string  `db:"content" json:"content"`
	CreatedAt    string  `db:"created_at" json:"created_at"`
	Origin       *string `db:"origin" json:"origin,omitempty"`
	IsSystem     bool    `db:"is_system" json:"is_system"`
}

// ListGuideMessagesSince returns the board's latest messages written at or after since (an RFC 3339 UTC time), oldest first, up to limit, as GuideMessage: not one addressed to a group, not a cross-team
// message (its envelope names another team, in either direction) and not Coral Hub's notice about a team link. A guide reads what this team's own members and people said, from the day the grant was accepted.
func (s *Store) ListGuideMessagesSince(ctx context.Context, project, since string, limit int) ([]GuideMessage, error) {
	var messages []GuideMessage
	err := s.reader().SelectContext(ctx, &messages,
		`SELECT * FROM (
		    SELECT m.id, m.subscriber_id, COALESCE(s.job_title, m.subscriber_id, 'Unknown') as job_title, m.content, m.created_at, m.origin, m.is_system
		    FROM board_messages m
		    LEFT JOIN board_subscribers s ON m.project = s.project AND m.subscriber_id = s.subscriber_id
		    WHERE m.project = ? AND m.created_at >= ? AND m.target_group_id IS NULL AND m.external_json IS NULL AND COALESCE(m.origin, '') != ?
		    ORDER BY m.id DESC LIMIT ?
		 ) ORDER BY id ASC`, project, since, OriginHubNotice, limit)
	return messages, err
}

// CountGuideMessagesSince is how many messages a guide's label wrote on a board at or after since: Coral's own ceiling, whatever the Hub's rate caps are.
func (s *Store) CountGuideMessagesSince(ctx context.Context, project, label, since string) (int, error) {
	var n int
	err := s.reader().GetContext(ctx, &n, `SELECT COUNT(*) FROM board_messages WHERE project = ? AND subscriber_id = ? AND origin = ? AND created_at >= ?`, project, label, OriginHubGuide, since)
	return n, err
}

// CountProposalsSince is how many proposals a proposer left on a board at or after since, whatever became of them.
func (s *Store) CountProposalsSince(ctx context.Context, project, proposer, since string) (int, error) {
	var n int
	err := s.reader().GetContext(ctx, &n, `SELECT COUNT(*) FROM board_proposals WHERE board_id = ? AND proposer = ? AND created_at >= ?`, project, proposer, since)
	return n, err
}

// guideNameTaken reports whether a display name is the id or the job title of a member of the board (compared without case or surrounding space): a guide's name must never read as a member's.
func (s *Store) guideNameTaken(ctx context.Context, project, name string) (bool, error) {
	var n int
	err := s.reader().GetContext(ctx, &n, `SELECT COUNT(*) FROM board_subscribers WHERE project = ? AND (LOWER(TRIM(subscriber_id)) = LOWER(TRIM(?)) OR LOWER(TRIM(job_title)) = LOWER(TRIM(?)))`, project, name, name)
	return n > 0, err
}

// GuideDisplayName is the name the board writes for a guide in the text agents read: the roster's, unless a member has taken that name since (an id or a job title of this board), then "a guide".
func (s *Store) GuideDisplayName(ctx context.Context, project, label string) string {
	roster, err := s.GetGuideRoster(ctx, project)
	if err != nil {
		return GuideName(nil, label)
	}
	name := roster[label]
	if name == "" {
		return GuideName(nil, label)
	}
	if taken, err := s.guideNameTaken(ctx, project, name); err != nil || taken {
		return GuideName(nil, label)
	}
	return name
}

func shortLabel(s string) string {
	if r := []rune(clitext.Clean(s)); len(r) > 24 {
		return string(r[:24])
	}
	return clitext.Clean(s)
}

// SetArtifactPrivate marks an artifact private to the manager, or clears the mark. The caller has decided who may (the Operator, or the Hub owner); a guide never does. Setting it twice is fine.
func (s *Store) SetArtifactPrivate(ctx context.Context, artifactID string, private bool, by string) error {
	if !ValidArtifactDigest(artifactID) {
		return fmt.Errorf("not an artifact id")
	}
	if !private {
		_, err := s.db.ExecContext(ctx, `DELETE FROM artifact_private WHERE artifact_id = ?`, artifactID)
		return err
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO artifact_private (artifact_id, set_by, set_at) VALUES (?, ?, ?) ON CONFLICT (artifact_id) DO NOTHING`, artifactID, shortLabel(by), nowUTC())
	return err
}

// ArtifactPrivate reports whether an artifact is marked private to the manager. An error means the answer is unknown, and a guide's read is then refused.
func (s *Store) ArtifactPrivate(ctx context.Context, artifactID string) (bool, error) {
	var n int
	err := s.reader().GetContext(ctx, &n, `SELECT COUNT(*) FROM artifact_private WHERE artifact_id = ?`, artifactID)
	return n > 0, err
}

// PrivateArtifacts is the subset of ids that are private, in one read.
func (s *Store) PrivateArtifacts(ctx context.Context, ids []string) (map[string]bool, error) {
	out := map[string]bool{}
	for start := 0; start < len(ids); start += 500 {
		end := start + 500
		if end > len(ids) {
			end = len(ids)
		}
		chunk := ids[start:end]
		args := make([]any, len(chunk))
		for i, id := range chunk {
			args[i] = id
		}
		var found []string
		if err := s.reader().SelectContext(ctx, &found, `SELECT artifact_id FROM artifact_private WHERE artifact_id IN (`+strings.TrimSuffix(strings.Repeat("?,", len(chunk)), ",")+`)`, args...); err != nil {
			return nil, err
		}
		for _, id := range found {
			out[id] = true
		}
	}
	return out, nil
}

var artifactDigestRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ValidArtifactDigest reports whether s is the 64 lower-case hex digits of an artifact id.
func ValidArtifactDigest(s string) bool { return artifactDigestRe.MatchString(s) }
