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

// ListMessagesSince returns the board's latest messages written at or after since (an RFC 3339 UTC time), oldest first, up to limit, leaving out any message addressed to a group of members: a guide
// reads what the whole board was told from the day the grant was accepted, nothing earlier and nothing private.
func (s *Store) ListMessagesSince(ctx context.Context, project, since string, limit int) ([]Message, error) {
	var messages []Message
	err := s.reader().SelectContext(ctx, &messages,
		`SELECT * FROM (
		    SELECT m.id, m.project, m.subscriber_id, m.session_id, m.content, m.created_at,
		           COALESCE(s.job_title, m.subscriber_id, 'Unknown') as job_title,
		           m.target_group_id, m.external_json, m.origin, m.hub_user, m.is_system, m.task_id
		    FROM board_messages m
		    LEFT JOIN board_subscribers s ON m.project = s.project AND m.subscriber_id = s.subscriber_id
		    WHERE m.project = ? AND m.created_at >= ? AND m.target_group_id IS NULL
		    ORDER BY m.id DESC LIMIT ?
		 ) ORDER BY id ASC`, project, since, limit)
	return messages, err
}

func shortLabel(s string) string {
	if r := []rune(clitext.Clean(s)); len(r) > 24 {
		return string(r[:24])
	}
	return clitext.Clean(s)
}
