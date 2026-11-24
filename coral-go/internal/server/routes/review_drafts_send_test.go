package routes

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #21194 (S2 of #21189): Send comments is one message, once.

func (rig *cmtRig) forgetWrites() {
	rig.h.commentLimit.mu.Lock()
	rig.h.commentLimit.seen = nil
	rig.h.commentLimit.mu.Unlock()
}

func (rig *cmtRig) draft(body string, anchor map[string]any) {
	rig.t.Helper()
	rig.forgetWrites()
	code, out := rig.do(http.MethodPost, draftsPath(cmtDoc), cmtAsOwner, map[string]any{"body": body, "anchor": anchor, "board": "team-a"})
	require.Equal(rig.t, http.StatusCreated, code, "%v", out)
}

func (rig *cmtRig) draftRevision() float64 {
	rig.t.Helper()
	_, out := rig.do(http.MethodGet, draftsPath(cmtDoc)+"?board=team-a", cmtAsOwner, nil)
	return out["revision"].(float64)
}

func (rig *cmtRig) sendDrafts(requestID string, revision float64) (int, map[string]any) {
	return rig.do(http.MethodPost, draftsPath(cmtDoc)+"/send", cmtAsOwner, map[string]any{"board": "team-a", "request_id": requestID, "revision": revision})
}

func TestSendCommentsIsOneMessageWithEveryDraftInFullAndTheRepliesToAnswerThem(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.uploadedBy(1, "team-a")
	long := strings.Repeat("a long comment sentence. ", 80) // 2,000 characters: never cut
	rig.draft("Tighten section 2.", map[string]any{"whole": true})
	rig.draft(long, anchorOf("the lock"))
	rig.draft("Third: @QA please look", map[string]any{"whole": true})

	code, out := rig.sendDrafts("press-0001", rig.draftRevision())
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, "sent", out["status"])
	assert.Len(t, out["comment_ids"], 3)
	assert.EqualValues(t, 0, out["remaining_count"])

	msgs := rig.operatorMessages()
	require.Len(t, msgs, 1, "all the comments are ONE message")
	m := msgs[0].Content
	assert.True(t, strings.HasPrefix(m, "@Dev "))
	assert.Contains(t, m, "left 3 comments")
	assert.Contains(t, m, "Tighten section 2.")
	assert.Contains(t, m, long[:len(long)-1], "a comment is quoted in full")
	assert.Contains(t, m, "[the lock]", "the text a comment is on, quoted")
	assert.Contains(t, m, "on the whole document")
	assert.NotContains(t, m, "@QA", "a mention in a comment is defused")
	for _, id := range out["comment_ids"].([]any) {
		assert.Contains(t, m, fmt.Sprintf("coral-agent artifact reply coral://artifacts/%s %d ", cmtDoc, int64(id.(float64))), "the exact reply command of each thread")
		_, found, _ := rig.ss.GetArtifactAsk(context.Background(), int64(id.(float64)), sendSid(1))
		assert.True(t, found, "the agent is asked into each thread")
	}

	// The drafts are now published comments, and no drafts are left.
	_, got := rig.do(http.MethodGet, draftsPath(cmtDoc)+"?board=team-a", cmtAsOwner, nil)
	assert.EqualValues(t, 0, got["count"])
	_, list := rig.do(http.MethodGet, cp(cmtDoc), cmtAsOwner, nil)
	assert.Len(t, list["comments"], 3)
}

func TestTheSamePressAgainPostsNothing(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.uploadedBy(1, "team-a")
	rig.draft("one", map[string]any{"whole": true})
	rev := rig.draftRevision()
	code, first := rig.sendDrafts("press-0002", rev)
	require.Equal(t, http.StatusOK, code, "%v", first)
	code, again := rig.sendDrafts("press-0002", rev)
	require.Equal(t, http.StatusOK, code, "%v", again)
	assert.Equal(t, true, again["replayed"])
	assert.Equal(t, first["comment_ids"], again["comment_ids"])
	assert.Len(t, rig.operatorMessages(), 1, "the retry delivered nothing")
	// at once
	rig.draft("two", map[string]any{"whole": true})
	rev = rig.draftRevision()
	var wg sync.WaitGroup
	codes := make(chan int, 6)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, _ := rig.sendDrafts("press-0003", rev)
			codes <- c
		}()
	}
	wg.Wait()
	close(codes)
	for c := range codes {
		assert.Contains(t, []int{http.StatusOK, http.StatusConflict}, c)
	}
	assert.Len(t, rig.operatorMessages(), 2, "six presses at once posted one message")
}

func TestASendOnAStaleRevisionOrWithNothingChangesNothing(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.uploadedBy(1, "team-a")
	code, out := rig.sendDrafts("press-0004", 0)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "no_drafts", out["code"])
	rig.draft("one", map[string]any{"whole": true})
	rev := rig.draftRevision()
	rig.draft("two", map[string]any{"whole": true}) // the drafts changed after the person looked
	code, out = rig.sendDrafts("press-0005", rev)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "stale_revision", out["code"])
	assert.Empty(t, rig.operatorMessages())
	_, got := rig.do(http.MethodGet, draftsPath(cmtDoc)+"?board=team-a", cmtAsOwner, nil)
	assert.EqualValues(t, 2, got["count"], "both drafts are still drafts")
}

func TestAReviewTooLargeForOneMessageIsRefusedWholeNotSplit(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.uploadedBy(1, "team-a")
	big := strings.Repeat("x", 7000)
	for i := 0; i < 6; i++ { // 6 x 7 KB: over 32 KiB
		rig.draft(big+fmt.Sprint(i), map[string]any{"whole": true})
	}
	code, out := rig.sendDrafts("press-0006", rig.draftRevision())
	assert.Equal(t, http.StatusRequestEntityTooLarge, code, "%v", out)
	assert.Equal(t, "review_too_large", out["code"])
	assert.Contains(t, out["error"], "too long")
	assert.Empty(t, rig.operatorMessages(), "nothing was sent, not even a first part")
	_, got := rig.do(http.MethodGet, draftsPath(cmtDoc)+"?board=team-a", cmtAsOwner, nil)
	assert.EqualValues(t, 6, got["count"], "the drafts are untouched")
	_, list := rig.do(http.MethodGet, cp(cmtDoc), cmtAsOwner, nil)
	assert.Empty(t, list["comments"], "and none became a comment")
}

func TestASendThatReachesNoAgentKeepsTheDrafts(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.uploadedBy(1, "team-a")
	require.NoError(t, rig.ss.SetSessionArchived(context.Background(), sendSid(1), true))
	rig.draft("one", map[string]any{"whole": true})
	code, out := rig.sendDrafts("press-0007", rig.draftRevision())
	assert.Equal(t, http.StatusConflict, code, "%v", out)
	assert.Equal(t, "not_delivered", out["code"])
	_, got := rig.do(http.MethodGet, draftsPath(cmtDoc)+"?board=team-a", cmtAsOwner, nil)
	assert.EqualValues(t, 1, got["count"], "still a draft")
	_, list := rig.do(http.MethodGet, cp(cmtDoc), cmtAsOwner, nil)
	assert.Empty(t, list["comments"], "no comment was left behind")
	// The agent comes back: the same drafts go, and the first press id is free again.
	require.NoError(t, rig.ss.SetSessionArchived(context.Background(), sendSid(1), false))
	code, out = rig.sendDrafts("press-0007", rig.draftRevision())
	assert.Equal(t, http.StatusOK, code, "%v", out)
}

func TestOnlyTheOwnerSendsAndAPausedBoardOrNoUploaderRefuses(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.draft("one", map[string]any{"whole": true})
	rev := rig.draftRevision()
	code, out := rig.sendDrafts("press-0008", rev) // no upload record: nobody to send to
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "no_uploader", out["code"])
	rig.uploadedBy(1, "team-a")
	for name, hdr := range map[string]map[string]string{"hub viewer": cmtAsHub, "agent": cmtAsAgent, "forged": cmtAsForged} {
		c, _ := rig.do(http.MethodPost, draftsPath(cmtDoc)+"/send", hdr, map[string]any{"board": "team-a", "request_id": "press-0009", "revision": rev})
		assert.GreaterOrEqual(t, c, 400, name)
	}
	rig.h.boardHandler = &BoardHandler{paused: map[string]bool{"team-a": true}}
	code, out = rig.sendDrafts("press-0010", rev)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "board_paused", out["code"])
	rig.h.boardHandler = nil
	assert.Empty(t, rig.operatorMessages())
	_, got := rig.do(http.MethodGet, draftsPath(cmtDoc)+"?board=team-a", cmtAsOwner, nil)
	assert.EqualValues(t, 1, got["count"])
	_ = board.OperatorName
}

func TestTheDraftReadSaysWhoWouldGetTheSendAndWhetherItCanGo(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.draft("one", map[string]any{"whole": true})
	_, out := rig.do(http.MethodGet, draftsPath(cmtDoc)+"?board=team-a", cmtAsOwner, nil)
	assert.Equal(t, false, out["can_send"], "nobody uploaded the file")
	assert.Equal(t, "no_uploader", out["reason"])
	rig.uploadedBy(1, "team-a")
	_, out = rig.do(http.MethodGet, draftsPath(cmtDoc)+"?board=team-a", cmtAsOwner, nil)
	assert.Equal(t, true, out["can_send"])
	assert.Equal(t, []any{"Dev"}, out["targets"])
	assert.Empty(t, out["reason"])
}

func TestTheInboxCountOfDraftsIsTheOwnersOnTheVersionTheyAreOn(t *testing.T) {
	rig := newCmtRig(t)
	rig.draft("one", map[string]any{"whole": true})
	rig.draft("two", map[string]any{"whole": true})
	req, err := http.NewRequest(http.MethodGet, "/api/board/team-a/artifacts", nil)
	require.NoError(t, err)
	got, err := rig.h.ReviewDraftCountsFor(req)
	require.NoError(t, err)
	assert.Equal(t, map[string]int{cmtDoc: 2}, got, "the same reviewer key as the draft routes, per exact version")
}

// Through Coral Hub the linked owner keeps drafts and sends them under the same rules as at this computer; a Hub viewer and a forged stamp can neither read nor send.
func TestTheHubOwnerKeepsAndSendsDraftsAndAHubViewerCannot(t *testing.T) {
	rig := newCmtRig(t)
	withLabel(t, cmtHubUser, nil)
	rig.agent(1, "Dev", false)
	rig.uploadedBy(1, "team-a")
	rig.hubOn()
	body := map[string]any{"body": "from the hub", "anchor": map[string]any{"whole": true}, "board": "team-a"}
	for name, h := range map[string]map[string]string{"a hub viewer": cmtAsHub, "a second viewer": cmtAsHubTwo, "a forged stamp": cmtAsForged} {
		code, _ := rig.do(http.MethodPost, draftsPath(cmtDoc), h, body)
		assert.GreaterOrEqual(t, code, 400, name)
		code, _ = rig.do(http.MethodGet, draftsPath(cmtDoc), h, nil)
		assert.GreaterOrEqual(t, code, 400, name)
	}
	code, out := rig.do(http.MethodPost, draftsPath(cmtDoc), cmtAsHubOwner, body)
	require.Equal(t, http.StatusCreated, code, "%v", out)
	code, out = rig.do(http.MethodGet, draftsPath(cmtDoc)+"?board=team-a", cmtAsHubOwner, nil)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, true, out["can_send"], "the Hub's owner can send")
	rev := out["revision"]
	for name, h := range map[string]map[string]string{"a hub viewer": cmtAsHub, "a forged stamp": cmtAsForged} {
		code, _ = rig.do(http.MethodPost, draftsPath(cmtDoc)+"/send", h, map[string]any{"board": "team-a", "request_id": "press-hub-1", "revision": rev})
		assert.GreaterOrEqual(t, code, 400, name)
	}
	assert.Empty(t, rig.operatorMessages())
	code, out = rig.do(http.MethodPost, draftsPath(cmtDoc)+"/send", cmtAsHubOwner, map[string]any{"board": "team-a", "request_id": "press-hub-2", "revision": rev})
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Len(t, rig.operatorMessages(), 1)
}

func TestASendOnALockedDocumentIsRefusedAndKeepsTheDrafts(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.uploadedBy(1, "team-a")
	rig.draft("one", map[string]any{"whole": true})
	rev := rig.draftRevision()
	code, _ := rig.do(http.MethodPut, "/api/artifacts/"+cmtDoc+"/comments/lock", cmtAsOwner, nil)
	require.Equal(t, http.StatusOK, code)
	code, out := rig.sendDrafts("press-0011", rev)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "comments_locked", out["code"])
	assert.Empty(t, rig.operatorMessages())
	_, got := rig.do(http.MethodGet, draftsPath(cmtDoc)+"?board=team-a", cmtAsOwner, nil)
	assert.EqualValues(t, 1, got["count"])
}
