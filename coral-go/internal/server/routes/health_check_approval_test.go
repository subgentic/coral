package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/pkg/tunnel"
)

func (rg *checksRig) addCheck(t *testing.T, name string) board.HealthCheck {
	body := `{"name":"` + name + `","script":"` + rg.script(t) + `","dir":"` + rg.dir + `","every":"30m"}`
	code, out := rg.call("POST", "/x", body, "", checkAsSession("claude-orch"), rg.h.AddHealthCheckRoute)
	require.Equal(t, http.StatusOK, code, out)
	c, err := rg.h.bs.GetHealthCheck(context.Background(), "team", name)
	require.NoError(t, err)
	return c
}

// buttons returns the open approval question of a check and its two buttons by action.
func (rg *checksRig) approvalAsk(t *testing.T, name string) (int64, map[string]board.AskButton) {
	ids, err := rg.h.bs.OpenCheckApprovalAsks(context.Background(), "team", name)
	require.NoError(t, err)
	require.Len(t, ids, 1, "exactly one open approval question")
	got, err := rg.h.bs.AskButtonsOf(context.Background(), "team", ids)
	require.NoError(t, err)
	out := map[string]board.AskButton{}
	for _, b := range got[ids[0]] {
		out[b.Action] = b
	}
	return ids[0], out
}

func (rg *checksRig) click(t *testing.T, askID, buttonID int64, person, tunneled bool) (int, map[string]any) {
	req := httptest.NewRequest("POST", "/x", bytes.NewReader([]byte("{}")))
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("project", "team")
	rctx.URLParams.Add("messageID", strconv.FormatInt(askID, 10))
	rctx.URLParams.Add("buttonID", strconv.FormatInt(buttonID, 10))
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	if person {
		req = asPerson(req)
	}
	if tunneled {
		req.Header.Set(tunnel.ViaHeader, "x")
	}
	rec := httptest.NewRecorder()
	rg.h.ClaimAskButton(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestAnAddedCheckFilesOneApprovalQuestionWithApproveAndDeny(t *testing.T) {
	rg := newChecksRig(t)
	c := rg.addCheck(t, "stale-prs")
	askID, btns := rg.approvalAsk(t, "stale-prs")
	require.Contains(t, btns, board.ActionApproveCheck)
	require.Contains(t, btns, board.ActionDenyCheck)
	assert.Equal(t, "Approve", btns[board.ActionApproveCheck].Label)
	msgs, err := rg.h.bs.ListMessages(context.Background(), "team", 100, 0, 0)
	require.NoError(t, err)
	var text string
	for _, m := range msgs {
		if m.ID == askID {
			text = m.Content
		}
	}
	assert.True(t, strings.HasPrefix(text, "@Operator"))
	assert.Contains(t, text, c.ScriptHash, "the question carries the script's SHA-256")
	assert.Contains(t, text, "It can only read", "and, in words, that it may not write")
	// a change makes a new question and closes the old one
	rg.call("PUT", "/x", `{"may_write":true}`, "stale-prs", checkAsSession("claude-orch"), rg.h.ChangeHealthCheckRoute)
	_, again := rg.approvalAsk(t, "stale-prs")
	assert.Contains(t, again, board.ActionApproveCheck)
	ids, _ := rg.h.bs.OpenCheckApprovalAsks(context.Background(), "team", "stale-prs")
	assert.NotContains(t, ids, askID, "the old question is closed")
}

func TestTheOperatorsOneClickApprovesTheExactRecordAndNobodyElseCan(t *testing.T) {
	rg := newChecksRig(t)
	rg.addCheck(t, "stale-prs")
	askID, btns := rg.approvalAsk(t, "stale-prs")
	ap := btns[board.ActionApproveCheck]
	code, _ := rg.click(t, askID, ap.ID, false, false)
	assert.Equal(t, http.StatusForbidden, code, "an agent cannot click")
	code, out := rg.click(t, askID, ap.ID, true, true)
	assert.Equal(t, http.StatusForbidden, code, "through Coral Hub it is refused: approve on the computer it runs on")
	assert.Contains(t, []any{"owner_only", "this_computer_only"}, out["code"], "refused before or at the check button's own guard")
	c, _ := rg.h.bs.GetHealthCheck(context.Background(), "team", "stale-prs")
	require.Equal(t, board.CheckPending, c.State, "nothing approved yet")
	code, out = rg.click(t, askID, ap.ID, true, false)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, "approved", out["result"])
	c, _ = rg.h.bs.GetHealthCheck(context.Background(), "team", "stale-prs")
	assert.True(t, c.Approved())
	assert.Equal(t, "Operator", c.ApprovedBy)
	closed, _ := rg.h.bs.AskIsClosed(context.Background(), "team", askID)
	assert.True(t, closed)
}

func TestAnOldApproveNeverApprovesAChangedCheck(t *testing.T) {
	rg := newChecksRig(t)
	rg.addCheck(t, "stale-prs")
	askID, btns := rg.approvalAsk(t, "stale-prs")
	// the record changes behind the question (a store-level change, so no new question is filed)
	_, err := rg.h.bs.ChangeHealthCheck(context.Background(), "team", "stale-prs", func(c *board.HealthCheck) { c.MayWrite = true })
	require.NoError(t, err)
	code, out := rg.click(t, askID, btns[board.ActionApproveCheck].ID, true, false)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "check_changed", out["code"])
	c, _ := rg.h.bs.GetHealthCheck(context.Background(), "team", "stale-prs")
	assert.False(t, c.Approved(), "the old click approved nothing")
}

func TestDenyRemovesThePendingCheckAndEndsItsTokens(t *testing.T) {
	rg := newChecksRig(t)
	rg.addCheck(t, "stale-prs")
	askID, btns := rg.approvalAsk(t, "stale-prs")
	code, out := rg.click(t, askID, btns[board.ActionDenyCheck].ID, true, false)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, "denied", out["result"])
	_, err := rg.h.bs.GetHealthCheck(context.Background(), "team", "stale-prs")
	assert.ErrorIs(t, err, board.ErrCheckMissing)
	assert.Contains(t, rg.tok.revoked, "team/stale-prs")
}

func TestAnAgentCannotOfferACheckButton(t *testing.T) {
	_, err := board.ParseAskButton(1, "Approve="+board.ActionApproveCheck+":x:y", nil)
	assert.Error(t, err)
	_, err = board.ParseAskButton(1, "Deny="+board.ActionDenyCheck+":x:y", nil)
	assert.Error(t, err)
}

func TestRemovingACheckClosesItsApprovalQuestion(t *testing.T) {
	rg := newChecksRig(t)
	rg.addCheck(t, "stale-prs")
	rg.approvalAsk(t, "stale-prs")
	rg.call("DELETE", "/x", "", "stale-prs", checkAsSession("claude-orch"), rg.h.RemoveHealthCheckRoute)
	ids, _ := rg.h.bs.OpenCheckApprovalAsks(context.Background(), "team", "stale-prs")
	assert.Empty(t, ids)
}
