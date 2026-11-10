package routes

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
)

// #14130 (QA's SHOULD): every place that posts a comment to an agent records which message went to which agent session, so that agent's own coral-board read of it stamps read_at. The Send-to-agent route is pinned in
// artifact_comment_send_test.go; these two pin the other two: the auto-delivery of the Operator's comment to the uploader (deliverOperatorComment) and the goal comment to its driver (deliverGoalComment). Without the
// link the read stamps nothing, and each test fails.

// readAtOf is the asked agent's read_at in the owner's list at path, "" while unread; it fails when the thread has no ask for the agent.
func (rig *cmtRig) readAtOf(path string, cid int64, agent string) string {
	rig.t.Helper()
	code, list := rig.do("GET", path, cmtAsOwner, nil)
	require.Equal(rig.t, http.StatusOK, code, fmt.Sprint(list))
	for _, c := range list["comments"].([]any) {
		m := c.(map[string]any)
		if m["id"] != float64(cid) {
			continue
		}
		for _, a := range m["asks"].([]any) {
			k := a.(map[string]any)
			if k["agent"] == agent {
				r, present := k["read_at"]
				require.True(rig.t, present, "read_at is on every ask of the owner's list")
				return r.(string)
			}
		}
	}
	rig.t.Fatalf("no ask for %s in the thread of comment %d", agent, cid)
	return ""
}

// messageTo is the Operator's message that names the agent.
func (rig *cmtRig) messageTo(title string) board.Message {
	rig.t.Helper()
	for _, m := range rig.operatorMessages() {
		if strings.Contains(m.Content, "@"+title+" ") {
			return m
		}
	}
	rig.t.Fatalf("no message to %s", title)
	return board.Message{}
}

func (rig *cmtRig) readsBoard(title string, msgs ...board.Message) {
	rig.t.Helper()
	bh := NewBoardHandler(rig.h.bs)
	bh.SetCommentReadStamp(rig.h.StampCommentReads)
	bh.noteCommentReads(context.Background(), "team-a", naming.SubscriberID(title, "claude"), msgs)
}

func TestTheAutoDeliveredCommentIsReadWhenTheUploaderReadsItsMessage(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.agent(2, "QA", false)
	rig.uploadedBy(1, "team-a")
	rig.tag("for review")
	code, out := rig.commentAs(cmtAsOwner, nil)
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	require.Equal(t, "Dev", out["sent_to"])
	cid := int64(out["id"].(float64))
	msg := rig.messageTo("Dev")
	assert.Equal(t, "", rig.readAtOf(cp(cmtDoc), cid, "Dev"), "sent, not read")

	rig.readsBoard("QA", msg) // another member reading the uploader's message stamps nothing
	assert.Equal(t, "", rig.readAtOf(cp(cmtDoc), cid, "Dev"))
	rig.readsBoard("Dev", msg)
	got := rig.readAtOf(cp(cmtDoc), cid, "Dev")
	assert.NotEmpty(t, got, "the uploader's own read of the message that delivered the comment stamps read_at")
	_, err := time.Parse(time.RFC3339Nano, got)
	assert.NoError(t, err, "an RFC 3339 time: %q", got)
}

func TestTheGoalCommentIsReadWhenItsDriverReadsItsMessage(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.agent(2, "Orchestrator", false)
	path, _ := rig.goal("Dev")
	code, out := rig.do("POST", path, cmtAsOwner, goalComment(nil))
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	require.Equal(t, "Dev", out["sent_to"])
	cid := int64(out["id"].(float64))
	msg := rig.messageTo("Dev")
	assert.Equal(t, "", rig.readAtOf(path, cid, "Dev"), "sent, not read")

	rig.readsBoard("Orchestrator", msg) // the orchestrator reads everything: still nothing for the driver's ask
	assert.Equal(t, "", rig.readAtOf(path, cid, "Dev"))
	rig.readsBoard("Dev", msg)
	assert.NotEmpty(t, rig.readAtOf(path, cid, "Dev"), "the driver's own read of the message that delivered the goal comment stamps read_at")
}

// #15034: coral-board read --id N and --last N read through /messages/all, which did not stamp: a delivered comment shown that way stayed "not read". A verified member's own read stamps it; the Operator's does not.
func TestReadByIdAndReadLastStampTheDeliveredComment(t *testing.T) {
	for _, path := range []string{"id", "last"} {
		t.Run(path, func(t *testing.T) {
			rig := newCmtRig(t)
			rig.agent(1, "Dev", false)
			rig.uploadedBy(1, "team-a")
			rig.tag("for review")
			code, out := rig.commentAs(cmtAsOwner, nil)
			require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
			cid := int64(out["id"].(float64))
			msg := rig.messageTo("Dev")
			bh := NewBoardHandler(rig.h.bs)
			bh.SetCommentReadStamp(rig.h.StampCommentReads)
			url := "/api/board/team-a/messages/all?limit=5"
			if path == "id" {
				url = fmt.Sprintf("/api/board/team-a/messages/all?id=%d", msg.ID)
			}
			serve := func(actor Actor) {
				rec := httptest.NewRecorder()
				req := httptest.NewRequest(http.MethodGet, url, nil)
				req = withActor(req, actor)
				rc := chi.NewRouteContext()
				rc.URLParams.Add("project", "team-a")
				req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
				bh.ListAllMessages(rec, req)
				require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			}
			serve(Actor{Kind: ActorOperator, Name: "Operator"})
			assert.Equal(t, "", rig.readAtOf(cp(cmtDoc), cid, "Dev"), "the Operator's read stamps nothing")
			serve(Actor{Kind: ActorToken, Name: naming.SubscriberID("QA", "claude")})
			assert.Equal(t, "", rig.readAtOf(cp(cmtDoc), cid, "Dev"), "another member's read stamps nothing for the uploader's ask")
			serve(Actor{Kind: ActorToken, Name: naming.SubscriberID("Dev", "claude")})
			assert.NotEmpty(t, rig.readAtOf(cp(cmtDoc), cid, "Dev"), "the agent's own coral-board read --%s stamps read_at", path)
		})
	}
}
