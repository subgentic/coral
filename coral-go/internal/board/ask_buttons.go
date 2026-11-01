package board

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/clitext"
)

// Buttons on a question to the Operator (#11445, #11643): up to three, each one action from a closed list, declared by the agent as text and run by nobody until the Operator clicks. The agent's post carries a
// declaration, never a command: it is validated here against a fixed grammar and stored; Coral runs nothing from it. v1: open:new-agent, open:task:<id>, open:artifact:<digest>, reply, wake:<member>.
const (
	AskButtonMax      = 3  // buttons on one ask
	AskButtonLabelMax = 32 // characters in a label
	AskButtonsOpenMax = 10 // asks with buttons an agent may have open at once

	ButtonPending = "pending"
	ButtonUsed    = "used"

	ActionOpenNewAgent = "open:new-agent"
	ActionOpenTask     = "open:task"
	ActionOpenArtifact = "open:artifact"
	ActionReply        = "reply"
	ActionWake         = "wake"
)

// AskButton is one declared button. State is pending until the Operator claims it, then used.
type AskButton struct {
	ID        int64  `json:"id" db:"id"`
	MessageID int64  `json:"message_id" db:"message_id"`
	Pos       int    `json:"pos" db:"pos"`
	Label     string `json:"label" db:"label"`
	Action    string `json:"action" db:"action"`
	Arg       string `json:"arg,omitempty" db:"arg"`
	State     string `json:"state" db:"state"`
}

// ErrAskButton refuses a button declaration; the message names the button and the reason.
type ErrAskButton struct{ Msg string }

func (e *ErrAskButton) Error() string { return e.Msg }

var (
	buttonDigestRE = regexp.MustCompile(`^[a-f0-9]{64}$`)
	buttonLinkRE   = regexp.MustCompile(`(?i)(://|www\.|coral:|mailto:|data:|javascript:)`)
	buttonMemberRE = regexp.MustCompile(`^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$`)
)

// ParseAskButton reads "Label=action[:arg]" and refuses anything outside the grammar, naming the button (n is its place, from 1). A label is shown as text and, for reply, is the exact text sent, so one that
// hidden characters, an @, a link or a sign-in link would change is refused, never cleaned. signIn reports a sign-in link in a text (the caller owns that guard).
func ParseAskButton(n int, raw string, signIn func(string) bool) (AskButton, error) {
	bad := func(why string) (AskButton, error) {
		return AskButton{}, &ErrAskButton{Msg: fmt.Sprintf("button %d (%q): %s", n, clitext.CleanName(truncRunes(raw, 40)), why)}
	}
	i := strings.Index(raw, "=")
	if i < 0 {
		return bad(`write it as Label=action, for example "Yes, ship it=reply"`)
	}
	label, spec := strings.TrimSpace(raw[:i]), strings.TrimSpace(raw[i+1:])
	switch {
	case label == "":
		return bad("the label is empty")
	case utf8.RuneCountInString(label) > AskButtonLabelMax:
		return bad(fmt.Sprintf("the label is longer than %d characters", AskButtonLabelMax))
	case clitext.CleanName(label) != label:
		return bad("the label has hidden or control characters")
	case strings.ContainsRune(label, '@'):
		return bad("the label has an @")
	case buttonLinkRE.MatchString(label) || (signIn != nil && signIn(label)):
		return bad("the label has a link")
	}
	b := AskButton{Label: label, Pos: n, State: ButtonPending}
	switch {
	case spec == ActionOpenNewAgent:
		b.Action = ActionOpenNewAgent
	case spec == ActionReply:
		b.Action = ActionReply
	case strings.HasPrefix(spec, ActionOpenTask+":"):
		id, err := strconv.ParseInt(strings.TrimPrefix(spec, ActionOpenTask+":"), 10, 64)
		if err != nil || id <= 0 {
			return bad("open:task needs a task number, as open:task:12")
		}
		b.Action, b.Arg = ActionOpenTask, strconv.FormatInt(id, 10)
	case strings.HasPrefix(spec, ActionOpenArtifact+":"):
		d := strings.ToLower(strings.TrimPrefix(spec, ActionOpenArtifact+":"))
		d = strings.TrimPrefix(d, "coral://artifacts/")
		if !buttonDigestRE.MatchString(d) {
			return bad("open:artifact needs a 64-character digest")
		}
		b.Action, b.Arg = ActionOpenArtifact, d
	case strings.HasPrefix(spec, ActionWake+":"):
		m := strings.TrimSpace(strings.TrimPrefix(spec, ActionWake+":"))
		if !buttonMemberRE.MatchString(m) || clitext.CleanName(m) != m {
			return bad("wake needs the name of a member of this team, as wake:Dev")
		}
		b.Action, b.Arg = ActionWake, m
	default:
		return bad("the action must be open:new-agent, open:task:<number>, open:artifact:<digest>, reply or wake:<member>")
	}
	return b, nil
}

// ParseAskButtons reads every declaration; one bad button refuses them all.
func ParseAskButtons(raw []string, signIn func(string) bool) ([]AskButton, error) {
	if len(raw) > AskButtonMax {
		return nil, &ErrAskButton{Msg: fmt.Sprintf("an ask has at most %d buttons (this one has %d)", AskButtonMax, len(raw))}
	}
	out := make([]AskButton, 0, len(raw))
	seen := map[string]bool{}
	for i, r := range raw {
		b, err := ParseAskButton(i+1, r, signIn)
		if err != nil {
			return nil, err
		}
		if key := strings.ToLower(b.Label); seen[key] {
			return nil, &ErrAskButton{Msg: fmt.Sprintf("button %d (%q): two buttons have the same label", i+1, b.Label)}
		} else {
			seen[key] = true
		}
		out = append(out, b)
	}
	return out, nil
}

func truncRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// ErrTooManyButtonAsks refuses a new ask with buttons while the agent has AskButtonsOpenMax others open.
var ErrTooManyButtonAsks = errors.New("too many open questions with buttons: close or wait for one before asking another")

// OpenButtonAsks counts the asker's asks that still have a pending button and are not closed.
func (s *Store) OpenButtonAsks(ctx context.Context, project, asker string) (int, error) {
	var n int
	err := s.db.GetContext(ctx, &n, `SELECT COUNT(DISTINCT b.message_id) FROM board_ask_buttons b
		JOIN board_asks a ON a.message_id = b.message_id AND a.project = b.project
		WHERE b.project = ? AND a.asker = ? AND b.state = ?
		AND NOT EXISTS (SELECT 1 FROM board_ask_closed c WHERE c.message_id = b.message_id AND c.project = b.project)`, project, asker, ButtonPending)
	return n, err
}

// RecordAskButtons stores the declared buttons of an ask (already validated), in order, all pending.
func (s *Store) RecordAskButtons(ctx context.Context, project string, messageID int64, buttons []AskButton, now time.Time) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for i, b := range buttons {
		if _, err := tx.ExecContext(ctx, `INSERT INTO board_ask_buttons (project, message_id, pos, label, action, arg, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			project, messageID, i+1, b.Label, b.Action, b.Arg, ButtonPending, now.UTC().Format(time.RFC3339)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// AskButtonsOf is the buttons of the asks, by message id (an ask with none is absent).
func (s *Store) AskButtonsOf(ctx context.Context, project string, messageIDs []int64) (map[int64][]AskButton, error) {
	out := map[int64][]AskButton{}
	for _, id := range messageIDs {
		var rows []AskButton
		if err := s.db.SelectContext(ctx, &rows, `SELECT id, message_id, pos, label, action, arg, state FROM board_ask_buttons WHERE project = ? AND message_id = ? ORDER BY pos`, project, id); err != nil {
			return nil, err
		}
		if len(rows) > 0 {
			out[id] = rows
		}
	}
	return out, nil
}
