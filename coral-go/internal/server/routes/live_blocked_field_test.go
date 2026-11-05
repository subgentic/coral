package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

func liveRows(t *testing.T, serverURL string) map[string]map[string]any {
	t.Helper()
	resp, err := http.Get(serverURL + "/api/sessions/live")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var rows []map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&rows))
	out := map[string]map[string]any{}
	for _, r := range rows {
		sid, _ := r["session_id"].(string)
		out[sid] = r
	}
	return out
}

// A live row of a Codex agent whose model its login refuses carries blocked {kind: model_refused, model} (#13486), from the health monitor's last screen read: the key is absent on every other row (another
// agent type, nothing refused, a read that is gone, a sleeping agent), and the name Codex printed is repeated only when it is a safe one.
func TestALiveRowOfACodexAgentWhoseModelIsRefusedIsBlocked(t *testing.T) {
	server, _, mock, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	const refused, unnamed, fine, claude, asleep = "cccccccc-1486-4000-8000-000000000001", "cccccccc-1486-4000-8000-000000000002", "cccccccc-1486-4000-8000-000000000003", "cccccccc-1486-4000-8000-000000000004", "cccccccc-1486-4000-8000-000000000005"
	for sid, typ := range map[string]string{refused: "codex", unnamed: "codex", fine: "codex", claude: "claude", asleep: "codex"} {
		if sid != asleep {
			mock.addSession(naming.SessionName(typ, sid), "/tmp/project")
		}
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: "a-" + sid[len(sid)-1:], AgentType: typ, WorkingDir: "/tmp/project"}))
	}
	require.NoError(t, ss.SetSessionSleepingFor(ctx, asleep, ""))
	now := time.Now()
	ptymanager.NoteCodexModelRefusal(refused, "gpt-6.1-sol", true, now)
	ptymanager.NoteCodexModelRefusal(unnamed, "", true, now)
	ptymanager.NoteCodexModelRefusal(claude, "gpt-6.1-sol", true, now)
	ptymanager.NoteCodexModelRefusal(asleep, "gpt-6.1-sol", true, now)
	t.Cleanup(func() {
		for _, sid := range []string{refused, unnamed, fine, claude, asleep} {
			ptymanager.NoteCodexModelRefusal(sid, "", false, now)
		}
	})

	rows := liveRows(t, server.URL)
	assert.Equal(t, map[string]any{"kind": "model_refused", "model": "gpt-6.1-sol"}, rows[refused]["blocked"])
	assert.Equal(t, map[string]any{"kind": "model_refused", "model": ""}, rows[unnamed]["blocked"], "a refusal with no safe name still blocks, with an empty model")
	for _, sid := range []string{fine, claude, asleep} {
		_, has := rows[sid]["blocked"]
		assert.False(t, has, "row %s has no blocked key", sid)
	}

	ptymanager.NoteCodexModelRefusal(refused, "", false, now) // the screen no longer shows it
	_, has := liveRows(t, server.URL)[refused]["blocked"]
	assert.False(t, has, "a read that found no refusal clears the mark")
}

func TestABlockedMarkGoesByItselfWhenNobodyReadsTheScreenAnyMore(t *testing.T) {
	const sid = "cccccccc-1486-4000-8000-0000000000a1"
	t.Cleanup(func() { ptymanager.NoteCodexModelRefusal(sid, "", false, time.Now()) })
	ptymanager.NoteCodexModelRefusal(sid, "gpt-6.1-sol", true, time.Now().Add(-blockedMaxAge-time.Second))
	assert.Nil(t, blockedField(sid, "codex", false), "a read older than blockedMaxAge says nothing")
	ptymanager.NoteCodexModelRefusal(sid, "gpt-6.1-sol", true, time.Now().Add(-blockedMaxAge+10*time.Second))
	assert.NotNil(t, blockedField(sid, "codex", false), "a recent read does")
}

// The chat says the same fact in limit_notice for a refused Codex agent, named or not; any other agent's notice is as it was.
func TestTheChatsLimitNoticeSaysAModelIsRefused(t *testing.T) {
	const named, unnamed, other = "cccccccc-1486-4000-8000-0000000000b1", "cccccccc-1486-4000-8000-0000000000b2", "cccccccc-1486-4000-8000-0000000000b3"
	now := time.Now()
	t.Cleanup(func() {
		for _, s := range []string{named, unnamed, other} {
			ptymanager.NoteCodexModelRefusal(s, "", false, now)
		}
	})
	ptymanager.NoteCodexModelRefusal(named, "gpt-6.1-sol", true, now)
	ptymanager.NoteCodexModelRefusal(unnamed, "", true, now)
	assert.Equal(t, "Codex refuses its model gpt-6.1-sol: change the model for this agent.", modelRefusedNotice(named, "codex"))
	assert.Equal(t, "Codex refuses its model: change the model for this agent.", modelRefusedNotice(unnamed, "codex"))
	assert.Empty(t, modelRefusedNotice(other, "codex"), "nothing refused")
	assert.Empty(t, modelRefusedNotice(named, "claude"), "only Codex")
}

// ...and the chat's own notice path says it (chatNotices is what the chat reply's limit_notice comes from), ahead of a usage limit.
func TestTheChatRepliesLimitNoticeIsTheRefusalForARefusedCodexAgent(t *testing.T) {
	server, h, _, _ := setupSessionsTestServer(t)
	defer server.Close()
	const sid = "cccccccc-1486-4000-8000-0000000000c9"
	now := time.Now()
	t.Cleanup(func() { ptymanager.NoteCodexModelRefusal(sid, "", false, now) })
	r := httptest.NewRequest(http.MethodGet, "/api/sessions/live/codex-"+sid+"/chat", nil)
	_, _, notice := h.chatNotices(r, "codex-"+sid, "codex", sid, t.TempDir())
	assert.Empty(t, notice, "nothing is refused")
	ptymanager.NoteCodexModelRefusal(sid, "gpt-6.1-sol", true, now)
	_, _, notice = h.chatNotices(r, "codex-"+sid, "codex", sid, t.TempDir())
	assert.Equal(t, "Codex refuses its model gpt-6.1-sol: change the model for this agent.", notice)
}

// The mark lasts two minutes after the monitor's read and no longer (#13518): present at 119 s, gone at 121 s, with the constant pinned; a sleeping agent never carries it whatever was read.
func TestABlockedMarkLastsTwoMinutesAfterTheReadAndASleepingAgentNeverHasOne(t *testing.T) {
	require.Equal(t, 2*time.Minute, blockedMaxAge, "the spec says two minutes: a change of it is a change of the contract the dashboard reads")
	const sid = "cccccccc-1518-4000-8000-0000000000d1"
	t.Cleanup(func() { ptymanager.NoteCodexModelRefusal(sid, "", false, time.Now()) })
	ptymanager.NoteCodexModelRefusal(sid, "gpt-6.1-sol", true, time.Now().Add(-119*time.Second))
	assert.NotNil(t, blockedField(sid, "codex", false), "a read 119 s old still counts")
	assert.Nil(t, blockedField(sid, "codex", true), "a sleeping agent never carries it, however fresh the read")
	ptymanager.NoteCodexModelRefusal(sid, "gpt-6.1-sol", true, time.Now().Add(-121*time.Second))
	assert.Nil(t, blockedField(sid, "codex", false), "a read 121 s old says nothing")
}
