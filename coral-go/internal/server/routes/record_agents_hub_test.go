package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #13834 (Security MUST B): through a Hub the bulk Record for all agents records only the session and pid pairs the owner was shown. ?all=1 and a request with no list are refused by the machine's handler for
// both ways in, the tunnel's owner and the self-hosted Hub's genuine owner stamp, and the dry run still works for them.

func recordAs(t *testing.T, url string, hdr map[string]string, body any) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	req, err := http.NewRequest("POST", url, bytes.NewReader(b))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestAHubOwnerRecordsOnlyWhatTheDryRunShowedAndNeverWithAll(t *testing.T) {
	srv, term, ss, nameA, _ := recordFixture(t)
	st, err := ss.GetSettingsForCLI(context.Background())
	require.NoError(t, err)
	term.paused[nameA] = true
	term.cand[nameA] = ptymanager.AgentCandidate{PID: 100, Start: "s1", Program: "claude", Image: st["cli_path_claude"]}
	withLabel(t, cmtHubUser, nil)
	callers := map[string]map[string]string{
		"the tunnel's owner":          {tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubUserHeader: cmtHubUser, tunnel.HubRoleHeader: "owner", "X-Test-Kind": callerHub},
		"the self-hosted Hub's owner": {"X-Test-Kind": callerHubOwner},
	}
	for who, hdr := range callers {
		t.Run(who, func(t *testing.T) {
			code, out := recordAs(t, srv+"/api/sessions/record-agents?all=1", hdr, map[string]any{})
			assert.Equal(t, http.StatusBadRequest, code, out)
			assert.Equal(t, "all_not_from_hub", out["code"])
			code, out = recordAs(t, srv+"/api/sessions/record-agents", hdr, map[string]any{})
			assert.Equal(t, http.StatusBadRequest, code, "no list")
			assert.Equal(t, "read_first", out["code"])
			assert.Empty(t, term.recorded, "none of those recorded anything")
			code, out = recordAs(t, srv+"/api/sessions/record-agents?dry_run=1", hdr, map[string]any{})
			require.Equal(t, http.StatusOK, code, "the dry run is open to a Hub owner: %v", out)
			shown, _ := out["recorded"].([]any)
			require.Len(t, shown, 1)
			assert.Empty(t, term.recorded, "a dry run records nothing")
		})
	}
	// the pairs shown, sent back, are recorded (the tunnel's owner)
	code, out := recordAs(t, srv+"/api/sessions/record-agents", callers["the tunnel's owner"], map[string]any{"agents": []map[string]any{{"session": nameA, "pid": 100}}})
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, 100, term.recorded[nameA].PID)
}

func TestARecordFromAHubThatIsNotTheOwnerIsRefusedAndNothingIsRecorded(t *testing.T) {
	srv, term, ss, nameA, _ := recordFixture(t)
	st, _ := ss.GetSettingsForCLI(context.Background())
	term.paused[nameA] = true
	term.cand[nameA] = ptymanager.AgentCandidate{PID: 100, Start: "s1", Program: "claude", Image: st["cli_path_claude"]}
	withLabel(t, cmtHubUser, nil)
	grantee := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubUserHeader: cmtHubTwo, "X-Test-Kind": callerHub}
	for _, q := range []string{"", "?dry_run=1", "?all=1"} {
		code, _ := recordAs(t, srv+"/api/sessions/record-agents"+q, grantee, map[string]any{"agents": []map[string]any{{"session": nameA, "pid": 100}}})
		assert.Equal(t, http.StatusForbidden, code, "a Hub grantee"+q)
	}
	assert.Empty(t, term.recorded)
}
