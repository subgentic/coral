package routes

import (
	"context"
	"log/slog"
	"strings"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
)

// recordAskSubject keeps the goal and the task a question is about (#12164): the ones the post named (checked before it was posted), else, for a member's own question, the one task the member has claimed and its goal
// (nothing is guessed when it has two or none, and the Operator's own posts have no default). It only adds: a failure leaves the question as it was.
func (h *BoardHandler) recordAskSubject(ctx context.Context, project string, msg *board.Message, goalID, taskID int64) {
	if taskID == 0 && !strings.EqualFold(msg.SubscriberID, board.OperatorName) {
		if id, goal, ok, err := h.bs.ClaimedTaskOf(ctx, project, msg.SubscriberID); err == nil && ok {
			taskID = id
			if goalID == 0 {
				goalID = goal
			}
		}
	}
	if goalID == 0 && taskID > 0 { // a task named without its goal: the task's own goal
		if tk, err := h.bs.GetTask(ctx, project, taskID); err == nil && tk != nil && tk.GoalID != nil {
			goalID = *tk.GoalID
		}
	}
	if err := h.bs.RecordAskSubject(ctx, project, msg.ID, goalID, taskID); err != nil {
		slog.Warn("ask subject not recorded", "board", project, "message", msg.ID, "error", err)
	}
}

// askSubjectLinks is the goal and task of some questions as the pages show them: the ids, and the titles cleaned and cut (they are other people's words). Titles are looked up once per goal and per task.
type askSubjectLinks struct {
	h       *BoardHandler
	project string
	goals   map[int64]string
	tasks   map[int64]string
}

func (h *BoardHandler) askSubjects(ctx context.Context, project string, messageIDs []int64) (map[int64]board.AskSubject, *askSubjectLinks) {
	subjects, err := h.bs.AskSubjectsOf(ctx, project, messageIDs)
	if err != nil {
		subjects = map[int64]board.AskSubject{}
	}
	return subjects, &askSubjectLinks{h: h, project: project, goals: map[int64]string{}, tasks: map[int64]string{}}
}

func (l *askSubjectLinks) goalTitle(ctx context.Context, id int64) string {
	if id <= 0 {
		return ""
	}
	if t, ok := l.goals[id]; ok {
		return t
	}
	title := ""
	if g, err := l.h.bs.GetGoal(ctx, l.project, id); err == nil && g != nil {
		title = clitext.CleanName(g.Title)
	}
	l.goals[id] = title
	return title
}

func (l *askSubjectLinks) taskTitle(ctx context.Context, id int64) string {
	if id <= 0 {
		return ""
	}
	if t, ok := l.tasks[id]; ok {
		return t
	}
	title := ""
	if tk, err := l.h.bs.GetTask(ctx, l.project, id); err == nil && tk != nil {
		title = clitext.CleanName(tk.Title)
	}
	l.tasks[id] = title
	return title
}
