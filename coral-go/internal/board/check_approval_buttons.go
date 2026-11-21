package board

import (
	"context"
	"strings"
)

// The two buttons Coral itself puts on the approval question of a custom check (#20139). They are not in the agent grammar: ParseAskButton refuses both, so an agent can never offer one. Coral stores them
// when it files the question, and the Operator's click runs them on the server (the page only shows them), against the exact record hash they carry.
const (
	ActionApproveCheck = "approve-check"
	ActionDenyCheck    = "deny-check"
)

// IsCheckAction says whether a stored button belongs to a check's approval question.
func IsCheckAction(action string) bool {
	return action == ActionApproveCheck || action == ActionDenyCheck
}

// CheckButtonArg is the stored argument of a check button: the check's name and the record hash the Operator was shown, joined at the last colon (a name has none: names are plain words).
func CheckButtonArg(name, recordHash string) string { return name + ":" + recordHash }

// SplitCheckButtonArg is the reverse of CheckButtonArg.
func SplitCheckButtonArg(arg string) (name, recordHash string, ok bool) {
	i := strings.LastIndex(arg, ":")
	if i <= 0 || i == len(arg)-1 {
		return "", "", false
	}
	return arg[:i], arg[i+1:], true
}

// OpenCheckApprovalAsks lists the still-open approval questions filed for the check, newest last.
func (s *Store) OpenCheckApprovalAsks(ctx context.Context, project, name string) ([]int64, error) {
	var rows []struct {
		MessageID int64  `db:"message_id"`
		Arg       string `db:"arg"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT DISTINCT message_id, arg FROM board_ask_buttons WHERE project = ? AND action = ? ORDER BY message_id`, project, ActionApproveCheck); err != nil {
		return nil, err
	}
	var ids []int64
	for _, r := range rows {
		if n, _, ok := SplitCheckButtonArg(r.Arg); !ok || n != name {
			continue
		}
		if closed, _ := s.AskIsClosed(ctx, project, r.MessageID); !closed {
			ids = append(ids, r.MessageID)
		}
	}
	return ids, nil
}
