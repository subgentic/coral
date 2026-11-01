package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Save for later and Move to Needs you on the review route (#11641): a tag on the artifact, the Operator's alone, nothing sent to the agent. A saved file is out of Needs you and its counts (the Inbox
// badge, GET /api/needs-you) and is still for review, so Approve, Changes and Deny work on it and take the saved tag off.

func (e *reviewEnv) waiting(t *testing.T) int {
	req := asPerson(httptest.NewRequest(http.MethodGet, "/api/needs-you", nil))
	w := httptest.NewRecorder()
	e.h.NeedsYou(w, req)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var out map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	return int(out["count"].(float64))
}

func TestSaveKeepsTheFileForReviewTellsNobodyAndUnsaveRestoresIt(t *testing.T) {
	e := newReviewEnv(t, true)
	e.tag(t, `["for review", "read"]`)
	code, out := e.decide(t, `{"decision":"save"}`)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, true, out["changed"])
	assert.Equal(t, false, out["delivered"])
	assert.Equal(t, []any{"for review", "read", "saved"}, out["tags"], "it stays for review: the decisions still work on it")
	assert.NotContains(t, out, "state", "saving is not a verdict")
	assert.Empty(t, e.messages(t), "nothing is posted")

	code, out = e.decide(t, `{"decision":"save"}`)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, false, out["changed"], "saving twice does nothing")

	code, out = e.decide(t, `{"decision":"unsave"}`)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, true, out["changed"])
	assert.Equal(t, []any{"for review", "read"}, out["tags"], "exactly the tags it had")
	assert.Empty(t, e.messages(t), "nothing is posted")

	code, out = e.decide(t, `{"decision":"unsave"}`)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, false, out["changed"], "moving back what is not saved does nothing")
}

func TestSaveOfWhatIsNotForReviewIsRefused(t *testing.T) {
	e := newReviewEnv(t, true)
	e.tag(t, `[]`)
	code, out := e.decide(t, `{"decision":"save"}`)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "not_for_review", out["code"])
}

func TestSaveIsTheOperatorsAlone(t *testing.T) {
	e := newReviewEnv(t, false)
	e.tag(t, `["for review"]`)
	for _, d := range []string{`{"decision":"save"}`, `{"decision":"unsave"}`} {
		code, _ := e.decide(t, d)
		assert.Equal(t, http.StatusForbidden, code, d)
	}
}

func TestASavedFileIsNotCountedByNeedsYou(t *testing.T) {
	e := newReviewEnv(t, true)
	e.tag(t, `["for review"]`)
	require.Equal(t, 1, e.waiting(t))
	code, _ := e.decide(t, `{"decision":"save"}`)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, 0, e.waiting(t), "saved: not waiting for the person now")
	code, _ = e.decide(t, `{"decision":"unsave"}`)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, 1, e.waiting(t), "moved back: waiting again")
}

func TestADecisionOnASavedFileTakesTheSavedTagOff(t *testing.T) {
	for _, tc := range []struct{ decision, want string }{
		{"approve", `["approved"]`}, {"deny", `["denied"]`}, {"changes", `["changes requested","for review"]`}, {"ignore", `["ignored","read"]`},
	} {
		t.Run(tc.decision, func(t *testing.T) {
			e := newReviewEnv(t, true)
			e.tag(t, `["for review", "read"]`)
			code, out := e.decide(t, `{"decision":"save"}`)
			require.Equal(t, http.StatusOK, code, out)
			code, out = e.decide(t, `{"decision":"`+tc.decision+`"}`)
			require.Equal(t, http.StatusOK, code, out)
			b, _ := json.Marshal(out["tags"])
			assert.JSONEq(t, tc.want, string(b), "no saved tag is left behind (and read goes where the decision takes it)")
		})
	}
}
