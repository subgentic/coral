package board

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/clitext"
)

// A clash (#11457, S6): two people gave different directions on one task, goal or artifact, and at least one of them is a guide. Coral does not pick: an agent of the team files the two messages, and Coral
// writes ONE ask to the Operator that quotes both stored messages whole, with their authors and roles, and says the work on that target is held until the Operator decides. Nothing the filing agent types
// reaches the ask: the target is a closed form and the quotes are the stored messages'. While that ask is open the same target is not filed again.

// MaxOpenClashes is the most clashes a board may have open at once.
const MaxOpenClashes = 5

// maxClashQuote bounds each quoted direction, in characters.
const maxClashQuote = 400

var (
	clashTargetRe = regexp.MustCompile(`^(task|goal):([0-9]{1,15})$|^artifact:([0-9a-f]{64})$`)
	// The clash errors the handler turns into plain sentences.
	ErrClashTarget   = errors.New("name the disputed work as task:N, goal:N or artifact:<64 hex digits>")
	ErrClashNoTarget = errors.New("that task, goal or artifact is not on this board")
	ErrClashMessages = errors.New("a clash needs two different messages of this board from two different people, and at least one of them a guide's")
	ErrClashSame     = errors.New("those two messages say the same thing: there is nothing to decide")
	ErrClashTooMany  = errors.New("this board already has the most clashes open it can hold: the Operator has to decide some first")
)

// MaxClashesPerAgentHour is the most clashes one agent may file in an hour.
const MaxClashesPerAgentHour = 5

// CountClashesBy is how many clashes one agent filed on a board at or after since.
func (s *Store) CountClashesBy(ctx context.Context, project, by, since string) (int, error) {
	var n int
	err := s.reader().GetContext(ctx, &n, `SELECT COUNT(*) FROM board_clashes WHERE project = ? AND filed_by = ? AND filed_at >= ?`, project, shortLabel(by), since)
	return n, err
}

// ClashResult says what filing did: the ask that now holds the target, and whether it was already there.
type ClashResult struct {
	AskID   int64 `json:"ask_id"`
	Existed bool  `json:"existed"`
}

// ValidClashTarget reports whether s is a target in its closed form.
func ValidClashTarget(s string) bool { return clashTargetRe.MatchString(s) }

func clashTextHash(s string) [32]byte {
	return sha256.Sum256([]byte(strings.ToLower(strings.Join(strings.Fields(clitext.Clean(s)), " "))))
}

// clashAuthor says who wrote a stored message and in what role, as the quote names them: a guide by the roster's name, the Operator, or an agent of the team by its member name.
func (s *Store) clashAuthor(ctx context.Context, project string, m *Message) string {
	switch {
	case m.Origin != nil && *m.Origin == OriginHubGuide:
		return "guide " + s.GuideDisplayName(ctx, project, m.SubscriberID)
	case IsOperatorName(m.SubscriberID) || (m.Origin != nil && *m.Origin == OriginHubOperator):
		return "the Operator"
	default:
		return "agent " + clitext.CleanName(m.SubscriberID)
	}
}

// FileClash files a clash for target from two messages of the board, by a verified agent. It refuses what is not a clash (see the errors), returns the ask already holding the target when one is open, and
// otherwise posts the one Coral ask to the Operator and records it. now is the time the ask is judged open against.
func (s *Store) FileClash(ctx context.Context, project, target string, aID, bID int64, by string, now time.Time) (*ClashResult, error) {
	if !ValidClashTarget(target) {
		return nil, ErrClashTarget
	}
	kind, id, _ := strings.Cut(target, ":")
	switch kind {
	case "task":
		n, _ := strconv.ParseInt(id, 10, 64)
		if t, err := s.GetTask(ctx, project, n); err != nil || t == nil {
			return nil, ErrClashNoTarget
		}
	case "goal":
		n, _ := strconv.ParseInt(id, 10, 64)
		if g, err := s.GetGoal(ctx, project, n); err != nil || g == nil {
			return nil, ErrClashNoTarget
		}
	}
	// the open ask for this target, if any
	if ask, open, err := s.openClashAsk(ctx, project, target, now); err != nil {
		return nil, err
	} else if open {
		return &ClashResult{AskID: ask, Existed: true}, nil
	}
	if n, err := s.openClashCount(ctx, project, now); err != nil {
		return nil, err
	} else if n >= MaxOpenClashes {
		return nil, ErrClashTooMany
	}
	if aID == bID || aID <= 0 || bID <= 0 {
		return nil, ErrClashMessages
	}
	a, err := s.GetMessageByID(ctx, project, aID)
	if err != nil || a == nil {
		return nil, ErrClashMessages
	}
	b, err := s.GetMessageByID(ctx, project, bID)
	if err != nil || b == nil {
		return nil, ErrClashMessages
	}
	isGuide := func(m *Message) bool { return m.Origin != nil && *m.Origin == OriginHubGuide }
	if SameIdentity(a.SubscriberID, b.SubscriberID) || a.IsSystem || b.IsSystem || (!isGuide(a) && !isGuide(b)) || a.TargetGroupID != nil || b.TargetGroupID != nil || len(a.External) > 0 || len(b.External) > 0 {
		return nil, ErrClashMessages
	}
	if clashTextHash(a.Content) == clashTextHash(b.Content) {
		return nil, ErrClashSame
	}
	subs, _ := s.ListSubscribers(ctx, project)
	names := make([]string, 0, len(subs))
	for _, sub := range subs {
		names = append(names, sub.SubscriberID)
	}
	quote := func(m *Message) string {
		text := clitext.Clean(m.Content)
		if r := []rune(text); len(r) > maxClashQuote {
			text = string(r[:maxClashQuote]) + "…"
		}
		return fmt.Sprintf("%s said: %q", s.clashAuthor(ctx, project, m), DefuseMentions(text, names))
	}
	content := fmt.Sprintf("@Operator [Coral] Two people gave different directions on %s, so the work on it is held: nobody acts on either until you decide. %s. %s. Answer this to decide (or close it once it is settled).", target, quote(a), quote(b))
	msg, err := s.PostSystemDefusedMessage(ctx, project, "Coral", content, nil)
	if err != nil {
		return nil, err
	}
	if err := s.RecordAsk(ctx, project, msg, []string{"Operator"}); err != nil {
		return nil, err
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO board_clashes (project, target, ask_id, a_msg, b_msg, filed_by, filed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		project, target, msg.ID, aID, bID, shortLabel(by), nowUTC()); err != nil {
		return nil, err
	}
	return &ClashResult{AskID: msg.ID}, nil
}

// openClashAsk returns the ask of the newest clash filed for target, and whether that ask is still open (neither answered nor closed).
func (s *Store) openClashAsk(ctx context.Context, project, target string, now time.Time) (int64, bool, error) {
	var askID int64
	err := s.reader().GetContext(ctx, &askID, `SELECT ask_id FROM board_clashes WHERE project = ? AND target = ? ORDER BY id DESC LIMIT 1`, project, target)
	if err != nil {
		return 0, false, nil // none filed
	}
	open, err := s.clashAskOpen(ctx, project, askID)
	return askID, open, err
}

func (s *Store) clashAskOpen(ctx context.Context, project string, askID int64) (bool, error) {
	var a askRow
	if err := s.reader().GetContext(ctx, &a, `SELECT message_id, asker, asked, created_at FROM board_asks WHERE project = ? AND message_id = ?`, project, askID); err != nil {
		return false, nil
	}
	subs, err := s.subscriberIndex(ctx, project)
	if err != nil {
		return false, err
	}
	info, err := s.askInfo(ctx, project, a, subs)
	if err != nil {
		return false, err
	}
	return len(info.Open) > 0, nil
}

func (s *Store) openClashCount(ctx context.Context, project string, now time.Time) (int, error) {
	var ids []int64
	if err := s.reader().SelectContext(ctx, &ids, `SELECT ask_id FROM board_clashes WHERE project = ? ORDER BY id DESC LIMIT 100`, project); err != nil {
		return 0, err
	}
	n := 0
	for _, id := range ids {
		if open, err := s.clashAskOpen(ctx, project, id); err != nil {
			return 0, err
		} else if open {
			n++
		}
	}
	return n, nil
}
