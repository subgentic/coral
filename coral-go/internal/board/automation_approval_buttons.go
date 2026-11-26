package board

import "context"

// The two buttons Coral itself puts on the approval question of an automation a team's Orchestrator proposed (#21505). Like the check buttons they are not in the agent grammar (ParseAskButton refuses both), and the
// Operator's click runs on the server against the exact hash the question carries.
const (
	ActionApproveAutomation = "approve-automation"
	ActionDenyAutomation    = "deny-automation"
)

// IsAutomationAction says whether a stored button belongs to an automation's approval question.
func IsAutomationAction(action string) bool {
	return action == ActionApproveAutomation || action == ActionDenyAutomation
}

// OpenAutomationApprovalAsks lists the still-open approval questions filed for the automation, newest last. The argument is the automation's name and the hash the Operator was shown, as for a check.
func (s *Store) OpenAutomationApprovalAsks(ctx context.Context, project, name string) ([]int64, error) {
	var rows []struct {
		MessageID int64  `db:"message_id"`
		Arg       string `db:"arg"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT DISTINCT message_id, arg FROM board_ask_buttons WHERE project = ? AND action = ? ORDER BY message_id`, project, ActionApproveAutomation); err != nil {
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
