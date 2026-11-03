package board

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// OffBooksOperatorWait is the kind of a line of the orchestrator's check about a post that waits on the Operator and is not in their Needs you (#12138, the Operator): a board post that @mentions the Operator, or
// says it needs them ("operator decides", "needs the operator", "say if you want", "your call" with the Operator named), with no --ask to them and no "for review" file linked within OperatorWaitGrace. The ref is the
// message, so a post is said once. The detail is a message number and a time, never the post's words.
const OffBooksOperatorWait = "operatorwait"

// OperatorWaitGrace is how long the author has to put what waits on the Operator in their Needs you (an --ask to the Operator, or a file tagged "for review" linked in a post) before it is said.
const OperatorWaitGrace = 10 * time.Minute

const settingOperatorWaitCursor = "health_operator_wait_cursor"

// OperatorWaitCursor is the id of the last board message the Operator-wait scan has judged; known is false before its first scan (which only marks where the board is).
func (s *Store) OperatorWaitCursor(ctx context.Context, project string) (id int64, known bool) {
	v, err := s.boardSettingValue(ctx, project, settingOperatorWaitCursor)
	if err != nil || v == "" {
		return 0, false
	}
	n, err := strconv.ParseInt(v, 10, 64)
	return n, err == nil
}

// SetOperatorWaitCursor keeps it.
func (s *Store) SetOperatorWaitCursor(ctx context.Context, project string, id int64) error {
	return s.SetBoardSetting(ctx, project, settingOperatorWaitCursor, strconv.FormatInt(id, 10))
}

// waitPhrases say a post needs the Operator without naming them with an @: each is read only when the post also names the Operator in words (the word "operator"), so "your call" in a talk between two agents is not one.
var waitPhrases = []string{"operator decides", "needs the operator", "needs operator", "waiting on the operator", "waiting for the operator", "for the operator to decide", "say if you want", "your call"}

var operatorWordRe = regexp.MustCompile(`(?i)\boperator\b`)

// WaitsOnOperator reports whether the post's words wait on the Operator: it @mentions them, or says a waiting phrase and names the Operator. It reads words only; whether the post is also an --ask is the caller's question.
func WaitsOnOperator(content string) bool {
	if mentionsOperator(content) {
		return true
	}
	if !operatorWordRe.MatchString(content) {
		return false
	}
	lower := strings.ToLower(content)
	for _, p := range waitPhrases {
		if strings.Contains(lower, p) {
			return true
		}
	}
	return false
}

var artifactHexRe = regexp.MustCompile(`coral://artifacts/([0-9a-f]{64})`)

// OperatorWaitCovered reports whether the author put the post in the Operator's Needs you within OperatorWaitGrace of it: the post itself or a later post of theirs inside the grace is an --ask to the Operator, or
// links a file of the board tagged "for review". later are the board's messages from the post on (the post included), oldest first, with their asks filled (ListMessagesAfter); tags is ArtifactTags of the board.
func OperatorWaitCovered(post Message, later []Message, tags map[string][]string) bool {
	at, err := time.Parse(time.RFC3339, post.CreatedAt)
	if err != nil {
		return false
	}
	for _, m := range later {
		if !SameIdentity(m.SubscriberID, post.SubscriberID) {
			continue
		}
		mt, err := time.Parse(time.RFC3339, m.CreatedAt)
		if err != nil || mt.Before(at) || mt.After(at.Add(OperatorWaitGrace)) {
			continue
		}
		if m.Ask != nil {
			for _, to := range m.Ask.To {
				if IsOperatorName(to) {
					return true
				}
			}
		}
		for _, hit := range artifactHexRe.FindAllStringSubmatch(m.Content, -1) {
			for _, tag := range tags[hit[1]] {
				if tag == tagForReview {
					return true
				}
			}
		}
	}
	return false
}
