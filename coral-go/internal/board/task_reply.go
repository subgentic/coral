package board

import (
	"context"
	"strings"

	"github.com/subgentic/coral/internal/clitext"
)

// The reply to a task (#5463): a board message linked to a task id (board_messages.task_id) whose text starts with a mention of the task's creator, so the existing mention
// delivery notifies them. The mention is only added when it tags exactly the creator (TaskReplyMention): delivery is textual, and a creator who has left, a job title that equals
// their name or a spaceless form can make "@<creator>: " tag someone else.

// ReplyMention is the mention a reply to a task starts with, and who it notifies.
type ReplyMention struct {
	// Prefix is "@<creator>: " when it tags exactly the creator (and nobody else), else "".
	Prefix string
	// Notified are the names the prefix tags: the creator, or nobody when the creator cannot be reached.
	Notified []string
}

// operatorName is the Operator's identity on a board (the dashboard's own).
const operatorName = "Operator"

// TaskReplyMention decides the mention of a reply to a task created by creator on project. The creator must be an ACTIVE subscriber (or the Operator, whose mentions the
// dashboard's notifications read), its name must be plain printable text, and the set of ACTIVE subscribers that "@<creator>: " alone tags (containsExplicitTag, with the
// board's numbered names) must be exactly {creator}: a different or additional member tagged means no mention at all. Nothing here reads the reply's own text.
func (s *Store) TaskReplyMention(ctx context.Context, project, creator string) ReplyMention {
	none := ReplyMention{Notified: []string{}}
	if creator == "" || len(creator) > 128 || clitext.Clean(creator) != creator || strings.ContainsAny(creator, "\r\n\t\x00") || strings.TrimSpace(creator) != creator {
		return none
	}
	var subs []struct {
		SubscriberID string `db:"subscriber_id"`
		JobTitle     string `db:"job_title"`
	}
	if err := s.reader().SelectContext(ctx, &subs, `SELECT subscriber_id, job_title FROM board_subscribers WHERE project = ? AND is_active = 1`, project); err != nil {
		return none
	}
	// The colon ends the name for good: after "@Backend Dev " a reply that begins with a digit would read "@Backend Dev 2" and tag the numbered agent instead (the numbered-name rule
	// of containsExplicitTag looks at the text that follows). Nothing the reply says can change who "@<creator>: " tags.
	prefix := "@" + creator + ": "
	numbered := s.numberedNames(ctx, s.reader(), project)
	isMember, isOperator := false, strings.EqualFold(creator, operatorName)
	var tagged []string
	for _, sub := range subs {
		if sub.SubscriberID == creator {
			isMember = true
		}
		if containsExplicitTag(prefix, sub.SubscriberID, sub.JobTitle, numbered) {
			tagged = append(tagged, sub.SubscriberID)
		}
	}
	switch {
	case isMember && len(tagged) == 1 && tagged[0] == creator:
		return ReplyMention{Prefix: prefix, Notified: []string{creator}}
	case !isMember && isOperator && len(tagged) == 0:
		// The Operator need not be a subscriber: the dashboard notifies an @Operator mention itself.
		return ReplyMention{Prefix: prefix, Notified: []string{creator}}
	}
	return none
}

// TaskReplyMentions decides the mentions of an agent's post on a task (#11431): the task's assignee and its creator, each tagged exactly as TaskReplyMention tags one (a name that is not an active member, or
// whose tag would also tag someone else, is left out), never the poster, and each once. The prefix is the mentions in the order given; Notified is who they reach.
// A recipient the post's own text already tags (text) is not given a prefix as well (#11586: "@UX/UX Engineer: @UX/UX Engineer ..."): the text's tag reaches them, so they are still in Notified.
func (s *Store) TaskReplyMentions(ctx context.Context, project string, names []string, poster, text string) ReplyMention {
	out := ReplyMention{Notified: []string{}}
	titles, numbered := s.replyTagContext(ctx, project)
	seen := map[string]bool{strings.ToLower(strings.TrimSpace(poster)): true}
	for _, name := range names {
		key := strings.ToLower(strings.TrimSpace(name))
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		m := s.TaskReplyMention(ctx, project, name)
		if m.Prefix == "" {
			continue
		}
		if !textTags(text, name, titles, numbered) {
			out.Prefix += m.Prefix
		}
		out.Notified = append(out.Notified, m.Notified...)
	}
	return out
}

// replyTagContext reads the active members' job titles (by subscriber id) and the board's numbered names, what textTags needs.
func (s *Store) replyTagContext(ctx context.Context, project string) (map[string]string, map[string]bool) {
	titles := map[string]string{}
	var subs []struct {
		SubscriberID string `db:"subscriber_id"`
		JobTitle     string `db:"job_title"`
	}
	if err := s.reader().SelectContext(ctx, &subs, `SELECT subscriber_id, job_title FROM board_subscribers WHERE project = ? AND is_active = 1`, project); err == nil {
		for _, sub := range subs {
			titles[sub.SubscriberID] = sub.JobTitle
		}
	}
	return titles, s.numberedNames(ctx, s.reader(), project)
}

// textTags reports whether text already tags name the way delivery reads a mention (the same test the prefix is checked with).
func textTags(text, name string, titles map[string]string, numbered map[string]bool) bool {
	return containsExplicitTag(text, name, titles[name], numbered)
}

// ListTaskReplies returns the replies to a task, oldest first, at most limit (the partial index on (project, task_id, id) answers it).
func (s *Store) ListTaskReplies(ctx context.Context, project string, taskID int64, limit int) ([]Message, error) {
	var messages []Message
	err := s.reader().SelectContext(ctx, &messages, listMessagesSelect+`
	 WHERE m.project = ? AND m.task_id = ?
	 ORDER BY m.id ASC LIMIT ?`, project, taskID, limit)
	return s.withAsks(ctx, project, messages, err)
}
