package board

import (
	"context"
	"database/sql"
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

	ButtonClaimTTL = time.Minute // an open or wake claim the page never settled is free again after this

	ButtonPending = "pending"
	ButtonUsed    = "used"
	ButtonClosed  = "closed"  // its question was answered in words, or closed: nothing left to click (#12610)
	ButtonExpired = "expired" // a wake button nobody clicked for WakeButtonLife

	// WakeButtonLife is how long a wake button stays clickable: a wake is only useful while the agent still needs waking for what was asked.
	WakeButtonLife = 24 * time.Hour

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
	case strings.ContainsAny(label, "\"'`\u2018\u2019\u201c\u201d\u00ab\u00bb[]"):
		return bad("the label has a quote or a bracket (it is posted inside quotes as the Operator's click, and must not be able to close them)")
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
	if err := s.resolveAskButtons(ctx, project, asker, time.Now()); err != nil { // answered or stale questions are not open: resolved first, so a person's reply frees the slot (#12610)
		return 0, err
	}
	var n int
	err := s.db.GetContext(ctx, &n, `SELECT COUNT(DISTINCT b.message_id) FROM board_ask_buttons b
		JOIN board_asks a ON a.message_id = b.message_id AND a.project = b.project
		WHERE b.project = ? AND a.asker = ? AND b.state = ?
		AND NOT EXISTS (SELECT 1 FROM board_ask_closed c WHERE c.message_id = b.message_id AND c.project = b.project)`, project, asker, ButtonPending)
	return n, err
}

// ResolveAskButtons settles the pending buttons of every question on every board that no longer needs a click: its question was closed or the Operator replied to it (a reply TO it, not a post that tags the asker), or a wake button is older than
// WakeButtonLife. It is the one-time clean-up of questions answered before buttons were resolved on an answer (#12610), and safe to run again.
func (s *Store) ResolveAskButtons(ctx context.Context, now time.Time) error {
	var projects []string
	if err := s.db.SelectContext(ctx, &projects, `SELECT DISTINCT project FROM board_ask_buttons WHERE state = ?`, ButtonPending); err != nil {
		return err
	}
	for _, p := range projects {
		if err := s.resolveAskButtons(ctx, p, "", now); err != nil {
			return err
		}
	}
	return nil
}

// resolveAskButtons does that for the questions of one board, those of asker when it is not empty.
func (s *Store) resolveAskButtons(ctx context.Context, project, asker string, now time.Time) error {
	q := `SELECT DISTINCT a.message_id, a.asker, a.asked, a.created_at FROM board_ask_buttons b JOIN board_asks a ON a.message_id = b.message_id AND a.project = b.project
		WHERE b.project = ? AND b.state = ?`
	args := []any{project, ButtonPending}
	if asker != "" {
		q += ` AND a.asker = ?`
		args = append(args, asker)
	}
	var asks []askRow
	if err := s.db.SelectContext(ctx, &asks, q, args...); err != nil || len(asks) == 0 {
		return err
	}
	for _, a := range asks {
		closed, err := s.AskIsClosed(ctx, project, a.MessageID)
		if err != nil {
			return err
		}
		if !closed {
			// Only a reply to THIS question resolves its buttons: a later post that merely tags the asker answers a plain question (the board's rule) but must not clear every button question the asker has open (#12490, #12610).
			if err := s.reader().GetContext(ctx, &closed, `SELECT EXISTS(SELECT 1 FROM board_messages m JOIN board_replies r ON r.message_id = m.id
				WHERE m.project = ? AND m.id > ? AND m.subscriber_id = 'Operator' AND COALESCE(m.is_system, 0) = 0 AND r.reply_to = ?)`, project, a.MessageID, a.MessageID); err != nil {
				return err
			}
		}
		if closed {
			if _, err := s.db.ExecContext(ctx, `UPDATE board_ask_buttons SET state = ? WHERE project = ? AND message_id = ? AND state = ?`, ButtonClosed, project, a.MessageID, ButtonPending); err != nil {
				return err
			}
			continue
		}
		if _, err := s.db.ExecContext(ctx, `UPDATE board_ask_buttons SET state = ? WHERE project = ? AND message_id = ? AND state = ? AND action = ? AND created_at < ?`,
			ButtonExpired, project, a.MessageID, ButtonPending, ActionWake, now.Add(-WakeButtonLife).UTC().Format(time.RFC3339)); err != nil {
			return err
		}
	}
	return nil
}

// PendingWakeButtons counts the wake buttons of a question that can still be clicked.
func (s *Store) PendingWakeButtons(ctx context.Context, project string, messageID int64) (int, error) {
	var n int
	err := s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM board_ask_buttons WHERE project = ? AND message_id = ? AND state = ? AND action = ?`, project, messageID, ButtonPending, ActionWake)
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

// The click (#11643): the Operator's own click claims a button, once.
var (
	ErrButtonUnknown = errors.New("no such button on this question")
	ErrButtonUsed    = errors.New("this question's button was already used")
	ErrAskClosed     = errors.New("this question is closed")
)

// AskButtonByID is one button of an ask of this board, or ErrButtonUnknown.
func (s *Store) AskButtonByID(ctx context.Context, project string, messageID, buttonID int64) (AskButton, error) {
	var b AskButton
	err := s.db.GetContext(ctx, &b, `SELECT id, message_id, pos, label, action, arg, state FROM board_ask_buttons WHERE project = ? AND message_id = ? AND id = ?`, project, messageID, buttonID)
	if errors.Is(err, sql.ErrNoRows) {
		return b, ErrButtonUnknown
	}
	return b, err
}

// AskIsClosed reports whether the question was closed by hand or the Operator already answered it.
func (s *Store) AskIsClosed(ctx context.Context, project string, messageID int64) (bool, error) {
	var n int
	err := s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM board_ask_closed WHERE project = ? AND message_id = ?`, project, messageID)
	return n > 0, err
}

// IsOpenAction says the action only opens something in the page (a task, a file, the new-agent dialog): reusable, never claimed (#12785).
func IsOpenAction(action string) bool {
	return action == ActionOpenTask || action == ActionOpenArtifact || action == ActionOpenNewAgent
}

// ClaimAskButton moves a pending button to used in ONE statement: it runs only if the button is pending, no other button of the same question is in use (a wake button is not held up by another wake: an Operator
// who was offered two wakes can click both, #12610) and the question is not closed, and the row count is
// checked, so a double click, two tabs or two buttons run one action. It returns the stored button; nothing the caller sent decides what it is.
func (s *Store) ClaimAskButton(ctx context.Context, project string, messageID, buttonID int64, now time.Time) (AskButton, error) {
	b, err := s.AskButtonByID(ctx, project, messageID, buttonID)
	if err != nil {
		return b, err
	}
	// An open button (a document, a task, the new-agent dialog) changes nothing on the board: it is never marked used, never holds up another button and never closes the question, so the Operator can open it again
	// and still answer (#12785). Only a closed question refuses it.
	if IsOpenAction(b.Action) {
		if closed, cerr := s.AskIsClosed(ctx, project, messageID); cerr != nil {
			return b, cerr
		} else if closed {
			return b, ErrAskClosed
		}
		return b, nil
	}
	// A claim the page never settled (a closed tab, a crash) is free again after a minute, so it cannot leave a question with no usable button. A reply is never freed: it was posted.
	if _, err := s.db.ExecContext(ctx, `UPDATE board_ask_buttons SET state = ?, used_at = '' WHERE project = ? AND message_id = ? AND state = ? AND reply_message_id = 0 AND action <> ? AND used_at <> '' AND used_at < ?`,
		ButtonPending, project, messageID, ButtonUsed, ActionReply, now.Add(-ButtonClaimTTL).UTC().Format(time.RFC3339)); err != nil {
		return b, err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE board_ask_buttons SET state = ?, used_at = ?
		WHERE project = ? AND message_id = ? AND id = ? AND state = ?
		AND NOT EXISTS (SELECT 1 FROM board_ask_buttons o WHERE o.project = ? AND o.message_id = ? AND o.state = ? AND NOT (? = ? AND o.action = ?))
		AND NOT EXISTS (SELECT 1 FROM board_ask_closed c WHERE c.project = ? AND c.message_id = ?)`,
		ButtonUsed, now.UTC().Format(time.RFC3339), project, messageID, buttonID, ButtonPending, project, messageID, ButtonUsed, b.Action, ActionWake, ActionWake, project, messageID)
	if err != nil {
		return b, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		if closed, cerr := s.AskIsClosed(ctx, project, messageID); cerr == nil && closed {
			return b, ErrAskClosed
		}
		return b, ErrButtonUsed
	}
	b.State = ButtonUsed
	return b, nil
}

// ReleaseAskButton gives a claimed button back (its action failed): used becomes pending again, unless it already posted its reply. It reports whether it released.
func (s *Store) ReleaseAskButton(ctx context.Context, project string, messageID, buttonID int64) (bool, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE board_ask_buttons SET state = ?, used_at = '' WHERE project = ? AND message_id = ? AND id = ? AND state = ? AND reply_message_id = 0`,
		ButtonPending, project, messageID, buttonID, ButtonUsed)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// SetAskButtonReply records the message a reply button posted, the stored mark that it came from a click.
func (s *Store) SetAskButtonReply(ctx context.Context, project string, buttonID, replyMessageID int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE board_ask_buttons SET reply_message_id = ? WHERE project = ? AND id = ?`, replyMessageID, project, buttonID)
	return err
}
