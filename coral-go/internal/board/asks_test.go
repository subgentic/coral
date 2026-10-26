package board

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func askBoard(t *testing.T) (*Store, context.Context) {
	t.Helper()
	s := testStore(t)
	ctx := context.Background()
	for _, who := range []string{"Lead", "Dev A", "Dev B"} {
		_, err := s.Subscribe(ctx, "alpha", who, who, "", nil, "")
		require.NoError(t, err)
	}
	return s, ctx
}

// post makes a message as who; ask records it as a question to those the text @mentions, replyTo links it as a reply.
func askPost(t *testing.T, s *Store, ctx context.Context, who, text string, ask bool, replyTo int64) *Message {
	t.Helper()
	if replyTo > 0 {
		require.NoError(t, s.CheckReplyTo(ctx, "alpha", replyTo))
	}
	var asked []string
	if ask {
		var err error
		asked, err = s.AskTargets(ctx, "alpha", who, text)
		require.NoError(t, err)
	}
	m, err := s.PostMessage(ctx, "alpha", who, text, nil)
	require.NoError(t, err)
	if ask {
		require.NoError(t, s.RecordAsk(ctx, "alpha", m, asked))
	}
	if replyTo > 0 {
		require.NoError(t, s.RecordReply(ctx, "alpha", m.ID, replyTo))
	}
	return m
}

func askOf(t *testing.T, s *Store, ctx context.Context, id int64) *AskInfo {
	t.Helper()
	m, err := s.GetMessageByID(ctx, "alpha", id)
	require.NoError(t, err)
	return m.Ask
}

// An ask opens for the members it @mentions, a reply (by --reply-to, or one that @mentions the asker) closes each member's part, and nothing else does.
func TestAnAskOpensAndEachMembersReplyClosesTheirPart(t *testing.T) {
	s, ctx := askBoard(t)
	q := askPost(t, s, ctx, "Lead", "@Dev A @Dev B which parser do we keep?", true, 0)
	info := askOf(t, s, ctx, q.ID)
	require.NotNil(t, info)
	assert.ElementsMatch(t, []string{"Dev A", "Dev B"}, info.To)
	assert.ElementsMatch(t, []string{"Dev A", "Dev B"}, info.Open)
	assert.False(t, info.Answered)

	askPost(t, s, ctx, "Dev A", "I did something else entirely", false, 0) // a post that is no reply
	assert.ElementsMatch(t, []string{"Dev A", "Dev B"}, askOf(t, s, ctx, q.ID).Open, "a post that neither names the question nor @mentions the asker does not answer it")

	askPost(t, s, ctx, "Dev A", "The old one: it is smaller.", false, q.ID) // --reply-to
	assert.Equal(t, []string{"Dev B"}, askOf(t, s, ctx, q.ID).Open)
	assert.False(t, askOf(t, s, ctx, q.ID).Answered, "one of two answered")

	askPost(t, s, ctx, "Dev B", "@Lead the new one, it is faster", false, 0) // the natural reply: it @mentions the asker
	info = askOf(t, s, ctx, q.ID)
	assert.Empty(t, info.Open)
	assert.True(t, info.Answered, "closed once each mentioned member has answered")

	// a member's post before the question is no answer to it
	q2 := askPost(t, s, ctx, "Lead", "@Dev A again?", true, 0)
	assert.Equal(t, []string{"Dev A"}, askOf(t, s, ctx, q2.ID).Open)
	// another asker's mention is no answer to this asker's question
	askPost(t, s, ctx, "Dev A", "@Dev B fyi", false, 0)
	assert.Equal(t, []string{"Dev A"}, askOf(t, s, ctx, q2.ID).Open)
}

func TestAnAskNeedsSomeoneToAskAndAReplyNeedsAMessage(t *testing.T) {
	s, ctx := askBoard(t)
	_, err := s.AskTargets(ctx, "alpha", "Lead", "no mention here")
	assert.ErrorIs(t, err, ErrAskNobody)
	_, err = s.AskTargets(ctx, "alpha", "Lead", "@all everyone?")
	assert.ErrorIs(t, err, ErrAskNobody, "@all names no one in particular")
	to, err := s.AskTargets(ctx, "alpha", "Lead", "@all and @Dev A: who has time?")
	require.NoError(t, err)
	assert.Equal(t, []string{"Dev A"}, to, "@all adds no one; a named member is asked")
	_, err = s.AskTargets(ctx, "alpha", "Lead", "@Lead asking myself")
	assert.ErrorIs(t, err, ErrAskNobody, "the asker is not asked")
	assert.ErrorIs(t, s.CheckReplyTo(ctx, "alpha", 424242), ErrReplyToUnknown)
	other, err := s.PostMessage(ctx, "beta", "Lead", "elsewhere", nil)
	require.NoError(t, err)
	assert.ErrorIs(t, s.CheckReplyTo(ctx, "alpha", other.ID), ErrReplyToUnknown, "another board's message is no message of this board")
}

// Messages read as a list carry ask and reply_to, and OpenAsks lists one row per member still owing (the reminder and the health check read it).
func TestOpenAsksAreOneRowPerMemberStillOwing(t *testing.T) {
	s, ctx := askBoard(t)
	q := askPost(t, s, ctx, "Lead", "@Dev A @Dev B ready?", true, 0)
	reply := askPost(t, s, ctx, "Dev A", "yes", false, q.ID)

	msgs, err := s.ListMessages(ctx, "alpha", 50, 0, 0)
	require.NoError(t, err)
	var gotQ, gotReply *Message
	for i := range msgs {
		switch msgs[i].ID {
		case q.ID:
			gotQ = &msgs[i]
		case reply.ID:
			gotReply = &msgs[i]
		}
	}
	require.NotNil(t, gotQ)
	require.NotNil(t, gotQ.Ask)
	assert.Equal(t, []string{"Dev B"}, gotQ.Ask.Open)
	require.NotNil(t, gotReply)
	require.NotNil(t, gotReply.ReplyTo)
	assert.Equal(t, q.ID, *gotReply.ReplyTo)
	assert.Nil(t, gotReply.Ask)

	open, err := s.OpenAsks(ctx, "alpha", time.Now())
	require.NoError(t, err)
	require.Len(t, open, 1)
	assert.Equal(t, OpenAsk{MessageID: q.ID, Asker: "Lead", Member: "Dev B", Content: "@Dev A @Dev B ready?", At: open[0].At}, open[0])

	askPost(t, s, ctx, "Dev B", "@Lead yes", false, 0)
	open, err = s.OpenAsks(ctx, "alpha", time.Now())
	require.NoError(t, err)
	assert.Empty(t, open, "answered: nothing open")

	// a question older than a week is left alone
	old := askPost(t, s, ctx, "Lead", "@Dev A ancient?", true, 0)
	open, err = s.OpenAsks(ctx, "alpha", time.Now().Add(askMaxAge+time.Hour))
	require.NoError(t, err)
	assert.Empty(t, open)
	_ = old
	// a member who left is not asked
	_, err = s.Unsubscribe(ctx, "alpha", "Dev A")
	require.NoError(t, err)
	open, err = s.OpenAsks(ctx, "alpha", time.Now())
	require.NoError(t, err)
	assert.Empty(t, open)
}

// The ask is an ordinary post for the notifier: in mentions mode the member it @mentions has it unread, the others do not (#7794: the asked agent is still nudged).
func TestAnAskStillCountsAsUnreadForTheMemberItMentions(t *testing.T) {
	s, ctx := askBoard(t)
	askPost(t, s, ctx, "Lead", "@Dev A what is the status?", true, 0)
	a, err := s.CheckUnread(ctx, "alpha", "Dev A")
	require.NoError(t, err)
	b, err := s.CheckUnread(ctx, "alpha", "Dev B")
	require.NoError(t, err)
	assert.Equal(t, 1, a, "the asked agent is nudged as for any mention")
	assert.Zero(t, b)
}

// #7845: an answer closes the question however many posts the member made before it: the reply and the mention are read without a cap.
func TestAnAnswerAfterManyPostsStillClosesTheQuestion(t *testing.T) {
	s, ctx := askBoard(t)
	byReply := askPost(t, s, ctx, "Lead", "@Dev A first question?", true, 0)
	byMention := askPost(t, s, ctx, "Lead", "@Dev B second question?", true, 0)
	for i := 0; i < 450; i++ { // more posts than a page, some that only look like a mention of the asker ("@Leader" is not "@Lead")
		_, err := s.PostMessage(ctx, "alpha", "Dev A", "working on it", nil)
		require.NoError(t, err)
		_, err = s.PostMessage(ctx, "alpha", "Dev B", "@Leader is not the asker, and this post is one of 450 that contain the asker's name as a prefix", nil)
		require.NoError(t, err)
	}
	assert.Equal(t, []string{"Dev A"}, askOf(t, s, ctx, byReply.ID).Open, "450 posts that answer nothing")
	assert.Equal(t, []string{"Dev B"}, askOf(t, s, ctx, byMention.ID).Open)

	askPost(t, s, ctx, "Dev A", "The old one.", false, byReply.ID)
	askPost(t, s, ctx, "Dev B", "@Lead the new one.", false, 0)
	assert.True(t, askOf(t, s, ctx, byReply.ID).Answered, "a reply after 450 posts closes it")
	assert.True(t, askOf(t, s, ctx, byMention.ID).Answered, "so does a mention of the asker")
}
