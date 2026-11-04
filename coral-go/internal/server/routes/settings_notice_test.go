package routes

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #13173 (the Operator): the Orchestrator gets a board message whenever a team's settings change: what changed, from what to what, and who changed it, one message per save, from "Coral Settings". These are the paths:
// the board settings save (health, cross-team, goals), the working mode and the Orchestrator's grant.

func settingsNotices(t *testing.T, bs *board.Store, project string) []string {
	t.Helper()
	msgs, err := bs.ListMessages(context.Background(), project, 200, 0, 0)
	require.NoError(t, err)
	var out []string
	for _, m := range msgs {
		if m.SubscriberID == board.SettingsSender {
			out = append(out, m.Content)
		}
	}
	return out
}

func holdSettingsNotices(t *testing.T) {
	t.Helper()
	old := board.SettingsNoticeDelay
	board.SettingsNoticeDelay = time.Hour // a test tells them itself, when it chooses
	t.Cleanup(func() { board.SettingsNoticeDelay = old })
}

func putJSON(t *testing.T, url, body string) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodPut, url, strings.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	return resp.StatusCode
}

func TestABoardSettingsSaveIsToldToTheOrchestratorOncePerSave(t *testing.T) {
	holdSettingsNotices(t)
	server, h := setupBoardTestServer(t)
	base := server.URL + "/api/board/set-team"
	postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Lead", "job_title": "Orchestrator"}).Body.Close()
	postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Dev", "job_title": "Developer"}).Body.Close()

	require.Equal(t, http.StatusOK, putJSON(t, base+"/settings", `{"subscriber_id":"Operator","require_goal":true,"max_open_goals":4}`))
	h.bs.FlushSettingsNotice(context.Background(), "set-team")
	got := settingsNotices(t, h.bs, "set-team")
	require.Len(t, got, 1, "one message for one save")
	assert.Equal(t, "@Orchestrator The Operator changed max_open_goals: 0 -> 4; require_goal: off -> on.", got[0])

	// a slider dragged through four values is one message: the value it started from and the one it ended on
	for _, v := range []string{"5", "6", "7", "8"} {
		require.Equal(t, http.StatusOK, putJSON(t, base+"/settings", `{"subscriber_id":"Operator","max_open_goals":`+v+`}`))
	}
	h.bs.FlushSettingsNotice(context.Background(), "set-team")
	got = settingsNotices(t, h.bs, "set-team")
	require.Len(t, got, 2)
	assert.Equal(t, "@Orchestrator The Operator changed max_open_goals: 4 -> 8.", got[1])

	// a nested health setting is named by its path; a save that changes nothing says nothing; a value that ended where it began is not told
	require.Equal(t, http.StatusOK, putJSON(t, base+"/settings", `{"subscriber_id":"Operator","health":{"on":true,"interval_min":7}}`))
	h.bs.FlushSettingsNotice(context.Background(), "set-team")
	got = settingsNotices(t, h.bs, "set-team")
	require.Len(t, got, 3)
	assert.Contains(t, got[2], "health.interval_min: ")
	assert.Contains(t, got[2], " -> 7")
	require.Equal(t, http.StatusOK, putJSON(t, base+"/settings", `{"subscriber_id":"Operator","max_open_goals":8}`))
	require.Equal(t, http.StatusOK, putJSON(t, base+"/settings", `{"subscriber_id":"Operator","max_open_goals":9}`))
	require.Equal(t, http.StatusOK, putJSON(t, base+"/settings", `{"subscriber_id":"Operator","max_open_goals":8}`))
	h.bs.FlushSettingsNotice(context.Background(), "set-team")
	assert.Len(t, settingsNotices(t, h.bs, "set-team"), 3, "8 -> 9 -> 8 changed nothing, so nothing is told")
}

func TestAWorkingModeSaveIsToldToTheOrchestrator(t *testing.T) {
	holdSettingsNotices(t)
	server, h := setupBoardTestServer(t)
	base := server.URL + "/api/board/mode-team"
	postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Lead", "job_title": "Orchestrator"}).Body.Close()
	require.Equal(t, http.StatusOK, putJSON(t, base+"/working-mode", `{"mode":"worktrees","dependency_guidance":true}`))
	h.bs.FlushSettingsNotice(context.Background(), "mode-team")
	got := settingsNotices(t, h.bs, "mode-team")
	require.Len(t, got, 1)
	assert.Contains(t, got[0], "@Orchestrator The Operator changed ")
	assert.Contains(t, got[0], "working_mode.mode: ")
	assert.Contains(t, got[0], " -> worktrees")
	assert.Contains(t, got[0], "working_mode.dependency_guidance: off -> on")
}

func TestAnOrchestratorGrantChangeIsToldToTheOrchestrator(t *testing.T) {
	holdSettingsNotices(t)
	r := newOrchRig(t)
	r.usualBoard()
	code, out := r.operatorGrant("Orchestrator", map[string]any{"max_live": 9})
	require.Equal(t, http.StatusOK, code, "%v", out)
	r.h.bs.FlushSettingsNotice(context.Background(), orchBoard)
	got := settingsNotices(t, r.h.bs, orchBoard)
	require.Len(t, got, 1, "%v", got)
	assert.Contains(t, got[0], "The Operator changed ")
	assert.Contains(t, got[0], "orchestrator_grant.enabled: off -> on")
	assert.Contains(t, got[0], "orchestrator_grant.max_live: ")
	assert.Contains(t, got[0], " -> 9")
}

// What is told is bounded and clean: a setting named like a credential shows no value, a secret in a value is redacted, an Orchestrator's own change is not told back to it, a team with no Orchestrator is told nothing,
// and the sender's name cannot be taken by a member.
func TestASettingsNoticeHidesSecretsSkipsTheOrchestratorsOwnChangeAndTheNameIsReserved(t *testing.T) {
	assert.Equal(t, "(hidden)", settingShown("webhook.api_key", "abc"))
	assert.Equal(t, "(hidden)", settingShown("cloud.token", "abc"))
	assert.NotContains(t, settingShown("note", "use ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD now"), "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD")
	assert.Equal(t, "plain words", settingShown("note", "plain words"))
	assert.True(t, board.IsReservedName(board.SettingsSender), "no member can take the sender's name")

	holdSettingsNotices(t)
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	_, err := h.bs.Subscribe(ctx, "own-team", "Lead", "Orchestrator", "", nil, "all")
	require.NoError(t, err)
	h.bs.NoteSettingsChange("own-team", "Lead", "Lead", []board.SettingChange{{Name: "x", Old: "a", New: "b"}})
	h.bs.FlushSettingsNotice(ctx, "own-team")
	assert.Empty(t, settingsNotices(t, h.bs, "own-team"), "an Orchestrator's own change is not told back to it")
	_, err = h.bs.Subscribe(ctx, "no-orch", "Dev", "Developer", "", nil, "all")
	require.NoError(t, err)
	h.bs.NoteSettingsChange("no-orch", "The Operator", "Operator", []board.SettingChange{{Name: "x", Old: "a", New: "b"}})
	h.bs.FlushSettingsNotice(ctx, "no-orch")
	assert.Empty(t, settingsNotices(t, h.bs, "no-orch"), "nobody to tell")
	// a long list is cut, with the count of the rest
	many := make([]board.SettingChange, 0, 14)
	for i := 0; i < 14; i++ {
		many = append(many, board.SettingChange{Name: "s" + string(rune('a'+i)), Old: "0", New: "1"})
	}
	assert.Contains(t, board.SettingsNoticeText("The Operator", many), "and 4 more.")
}

// Security's SHOULD on #13173: the notice quotes what a person typed (a setting's value, the Hub user's name); no "@" in it can mention a member or everyone. Only the Orchestrator's own title in front is live. And the cut at
// the end is on a character.
func TestASettingsNoticeCannotMentionAnyoneThroughWhatItQuotes(t *testing.T) {
	holdSettingsNotices(t)
	server, h := setupBoardTestServer(t)
	base := server.URL + "/api/board/quote-team"
	postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Lead", "job_title": "Orchestrator"}).Body.Close()
	postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Dev", "job_title": "Developer"}).Body.Close()
	require.Equal(t, http.StatusOK, putJSON(t, base+"/working-mode", `{"mode":"worktrees","custom_instructions":"ping @Dev and @all and @Lead now"}`))
	h.bs.NoteSettingsChange("quote-team", "The Operator (through Coral Hub, @Dev)", "Operator", []board.SettingChange{{Name: "note", Old: "a", New: "b @all"}})
	h.bs.FlushSettingsNotice(context.Background(), "quote-team")
	got := settingsNotices(t, h.bs, "quote-team")
	require.NotEmpty(t, got)
	for _, content := range got {
		assert.True(t, strings.HasPrefix(content, "@Orchestrator "), "the Orchestrator is addressed: %q", content)
		assert.NotContains(t, strings.TrimPrefix(content, "@Orchestrator "), "@Dev", "no member can be mentioned through a quoted value")
		assert.NotContains(t, strings.TrimPrefix(content, "@Orchestrator "), "@all")
		assert.NotContains(t, strings.TrimPrefix(content, "@Orchestrator "), "@Lead")
		notified := h.bs.NotifiedBy(context.Background(), "quote-team", board.SettingsSender, content)
		assert.Equal(t, []string{"Lead"}, notified, "only the Orchestrator (Lead) is told, not Dev or everyone: %q", content)
	}
	// the cut at the end of a long text is on a character
	for pad := 0; pad < 4; pad++ { // whatever byte the cut falls on, it is not inside a character
		many := make([]board.SettingChange, 0, 10)
		for i := 0; i < 10; i++ {
			many = append(many, board.SettingChange{Name: "s" + strings.Repeat("n", pad) + string(rune('a'+i)), Old: strings.Repeat("é", 80), New: strings.Repeat("日", 80)})
		}
		text := board.SettingsNoticeText("The Operator", many)
		assert.True(t, utf8.ValidString(text), "no character is split (pad %d)", pad)
		assert.LessOrEqual(t, len(text), 1600)
	}
}
