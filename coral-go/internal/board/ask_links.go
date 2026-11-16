package board

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Linked asks (#17738, walk 80 F3: one question shown four times). Several agents can need the same answer; `post --ask --same-as N` links a new question to an earlier open one. The first ask's id is the
// key every ask of the group shares; the Operator's Needs you can show one row for it, and one answer (or one close) of any ask of the group is an answer of all of them.

// LinkAsk makes the ask messageID the same question as sameAs: both must be asks of this board, and an ask is not linked to itself. When sameAs is already linked, messageID joins its key.
func (s *Store) LinkAsk(ctx context.Context, project string, messageID, sameAs int64) error {
	if messageID == sameAs {
		return errors.New("an ask is not the same question as itself")
	}
	for _, id := range []int64{messageID, sameAs} {
		if _, err := s.AskAsker(ctx, project, id); err != nil {
			return ErrAskUnknown
		}
	}
	root := s.askRoot(ctx, project, sameAs)
	if root == messageID {
		return errors.New("that ask already carries this one's key")
	}
	_, err := s.db.ExecContext(ctx, `INSERT OR REPLACE INTO board_ask_links (message_id, project, root) VALUES (?, ?, ?)`, messageID, project, root)
	return err
}

// askRoot is the key of the ask's group: its own id when it is the first of a group or alone.
func (s *Store) askRoot(ctx context.Context, project string, id int64) int64 {
	var root int64
	if err := s.reader().GetContext(ctx, &root, `SELECT root FROM board_ask_links WHERE project = ? AND message_id = ?`, project, id); err != nil {
		return id
	}
	return root
}

// AskKeysOf maps each linked ask among ids to its key; asks that are alone (or not asks) are absent.
func (s *Store) AskKeysOf(ctx context.Context, project string, ids []int64) (map[int64]int64, error) {
	out := map[int64]int64{}
	if len(ids) == 0 {
		return out, nil
	}
	args := []any{project}
	for _, id := range ids {
		args = append(args, id)
	}
	var rows []struct {
		MessageID int64 `db:"message_id"`
		Root      int64 `db:"root"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT message_id, root FROM board_ask_links WHERE project = ? AND message_id IN (`+placeholders(len(ids))+`)`, args...); err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.MessageID] = r.Root
		out[r.Root] = r.Root // the first ask of a group is linked to by the others
	}
	for id := range out { // only what was asked about
		found := false
		for _, want := range ids {
			if want == id {
				found = true
			}
		}
		if !found {
			delete(out, id)
		}
	}
	return out, nil
}

// LinkedAsk is another ask of the same group.
type LinkedAsk struct {
	ID    int64
	Asker string
}

// AskGroupOf are the other asks of id's group (none when it is alone), oldest first.
func (s *Store) AskGroupOf(ctx context.Context, project string, id int64) ([]LinkedAsk, error) {
	root := s.askRoot(ctx, project, id)
	var rows []LinkedAsk
	if err := s.reader().SelectContext(ctx, &rows, `SELECT a.message_id AS id, a.asker AS asker FROM board_asks a
		WHERE a.project = ? AND a.message_id != ? AND (a.message_id = ? OR a.message_id IN (SELECT message_id FROM board_ask_links WHERE project = ? AND root = ?)) ORDER BY a.message_id`,
		project, id, root, project, root); err != nil {
		return nil, err
	}
	return rows, nil
}

// RetiredAsk is a question a closing goal resolved, and who asked it.
type RetiredAsk struct {
	ID    int64
	Asker string
}

// RetireGoalAsks resolves the open asks of the board that are about goalID (#17738): each is closed with the note, as an ask closed by hand is, never approved or answered for anyone. Answered and
// already closed asks are left; so are asks about other goals. It returns the asks it closed so their askers can be told.
func (s *Store) RetireGoalAsks(ctx context.Context, project string, goalID int64, note string, now time.Time) ([]RetiredAsk, error) {
	var asks []askRow
	if err := s.reader().SelectContext(ctx, &asks, `SELECT a.message_id, a.asker, a.asked, a.created_at FROM board_asks a JOIN board_ask_subjects g ON g.project = a.project AND g.message_id = a.message_id
		WHERE a.project = ? AND g.goal_id = ? ORDER BY a.message_id`, project, goalID); err != nil {
		return nil, err
	}
	if len(asks) == 0 {
		return nil, nil
	}
	subs, err := s.subscriberIndex(ctx, project)
	if err != nil {
		return nil, err
	}
	var out []RetiredAsk
	for _, a := range asks {
		info, err := s.askInfo(ctx, project, a, subs)
		if err != nil {
			return nil, err
		}
		if info.Answered || info.Closed {
			continue
		}
		if err := s.CloseAsk(ctx, project, a.MessageID, "Goal "+fmt.Sprint(goalID), strings.TrimSpace(note)); err != nil {
			return nil, err
		}
		out = append(out, RetiredAsk{ID: a.MessageID, Asker: a.Asker})
	}
	return out, nil
}
