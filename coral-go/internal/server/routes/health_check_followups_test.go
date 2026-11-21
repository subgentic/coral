package routes

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #20220 (Security's SHOULDs on #20139 and #20176).

// Approve never un-pauses a check the Operator paused while it was pending: it says to resume it first, and the question stays to be clicked again.
func TestApproveRefusesAPausedPendingCheckAndTheQuestionStays(t *testing.T) {
	rg := newChecksRig(t)
	ctx := context.Background()
	rg.addCheck(t, "stale-prs")
	askID, btns := rg.approvalAsk(t, "stale-prs")
	require.NoError(t, rg.h.bs.PauseHealthCheck(ctx, "team", "stale-prs", true, time.Now()))
	ap := btns[board.ActionApproveCheck]
	code, out := rg.click(t, askID, ap.ID, true, false)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "check_paused", out["code"])
	assert.Contains(t, out["error"], "Resume it first")
	c, _ := rg.h.bs.GetHealthCheck(ctx, "team", "stale-prs")
	assert.Equal(t, board.CheckPaused, c.State, "still paused, nothing approved")
	closed, _ := rg.h.bs.AskIsClosed(ctx, "team", askID)
	assert.False(t, closed, "the question stays")
	// resumed, the same Approve works
	require.NoError(t, rg.h.bs.PauseHealthCheck(ctx, "team", "stale-prs", false, time.Now()))
	code, out = rg.click(t, askID, ap.ID, true, false)
	require.Equal(t, http.StatusOK, code, out)
	c, _ = rg.h.bs.GetHealthCheck(ctx, "team", "stale-prs")
	assert.True(t, c.Approved())
}

// The Operator reads the script text beside its hash, escaped; an agent's list never carries it.
func TestTheOperatorsListCarriesTheEscapedScriptTextAndAnAgentsDoesNot(t *testing.T) {
	rg := newChecksRig(t)
	p := filepath.Join(rg.dir, "odd.sh")
	require.NoError(t, os.WriteFile(p, []byte("#!/bin/sh\n# ‮ evil \x1b[31m\necho '{\"key\":\"a\",\"text\":\"hi\"}'\n"), 0o700))
	body := `{"name":"odd","script":"` + p + `","dir":"` + rg.dir + `","every":"30m"}`
	code, out := rg.call("POST", "/x", body, "", checkAsSession("claude-orch"), rg.h.AddHealthCheckRoute)
	require.Equal(t, http.StatusOK, code, out)

	_, agent := rg.call("GET", "/x", "", "", checkAsSession("claude-orch"), rg.h.ListHealthChecksRoute)
	for _, c := range agent["checks"].([]any) {
		assert.NotContains(t, c.(map[string]any), "script_text", "an agent's list carries no script text")
	}
	_, op := rg.call("GET", "/x", "", "", func(r *http.Request) { *r = *asPerson(r) }, rg.h.ListHealthChecksRoute)
	cs := op["checks"].([]any)
	require.Len(t, cs, 1)
	text, _ := cs[0].(map[string]any)["script_text"].(string)
	assert.Contains(t, text, "#!/bin/sh")
	assert.Contains(t, text, `\u{202e}`, "a bidi control is shown escaped, never raw")
	assert.Contains(t, text, `\u{1b}`, "so is an escape character")
	assert.NotContains(t, text, "‮")
	assert.NotContains(t, text, "\x1b")
}

// A snapshot lives as long as a check holds its hash: a change, a remove or a deny drops the superseded one, and a shared one stays for the check that still uses it.
func TestASupersededSnapshotIsDroppedAndASharedOneStays(t *testing.T) {
	rg := newChecksRig(t)
	snap := func(hash string) bool {
		_, err := os.Stat(filepath.Join(rg.h.checkSnapDir, hash))
		return err == nil
	}
	first := rg.addCheck(t, "one")
	second := rg.addCheck(t, "two") // the same script, the same snapshot
	require.Equal(t, first.ScriptHash, second.ScriptHash)
	require.True(t, snap(first.ScriptHash))

	// one is changed to another script: two still holds the old snapshot
	p2 := filepath.Join(rg.dir, "other.sh")
	require.NoError(t, os.WriteFile(p2, []byte("#!/bin/sh\necho '{\"key\":\"b\",\"text\":\"x\"}'\n"), 0o700))
	code, out := rg.call("PUT", "/x", `{"script":"`+p2+`"}`, "one", checkAsSession("claude-orch"), rg.h.ChangeHealthCheckRoute)
	require.Equal(t, http.StatusOK, code, out)
	changed, _ := rg.h.bs.GetHealthCheck(context.Background(), "team", "one")
	assert.True(t, snap(changed.ScriptHash))
	assert.True(t, snap(first.ScriptHash), "the old one stays: another check holds it")

	// two is removed: nothing holds the old one now
	code, out = rg.call("DELETE", "/x", "", "two", checkAsSession("claude-orch"), rg.h.RemoveHealthCheckRoute)
	require.Equal(t, http.StatusOK, code, out)
	assert.False(t, snap(first.ScriptHash), "the superseded snapshot is dropped")
	assert.True(t, snap(changed.ScriptHash), "the one in use stays")

	// an approval keeps the snapshot it approved
	askID, btns := rg.approvalAsk(t, "one")
	code, out = rg.click(t, askID, btns[board.ActionApproveCheck].ID, true, false)
	require.Equal(t, http.StatusOK, code, out)
	assert.True(t, snap(changed.ScriptHash))
	// a file that is not a snapshot's name is never touched
	other := filepath.Join(rg.h.checkSnapDir, "keep.txt")
	require.NoError(t, os.WriteFile(other, []byte("x"), 0o600))
	rg.call("PUT", "/x", `{"may_write":true}`, "one", checkAsSession("claude-orch"), rg.h.ChangeHealthCheckRoute)
	_, err := os.Stat(other)
	assert.NoError(t, err)
}
