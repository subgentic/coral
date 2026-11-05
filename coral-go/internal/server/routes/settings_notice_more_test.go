package routes

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
)

// #13221: the rest of the team settings are told to the Orchestrator too (review settings, a workflow preset, the guide roster), and QA Reviewer 2's SHOULDs on #13173: the 3 s window is real, the derived flags are left
// out, a value that reads as "Name:" or holds a control character is made safe, a title is cleaned, and a Hub change that is undone is not left told.
func TestReviewSettingsAPresetAndTheGuideRosterAreToldToTheOrchestrator(t *testing.T) {
	holdSettingsNotices(t)
	server, h := setupBoardTestServer(t)
	base := server.URL + "/api/board/rest-settings"
	postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Lead", "job_title": "Orchestrator"}).Body.Close()
	postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Rev", "job_title": "Reviewer"}).Body.Close()
	ctx := context.Background()
	told := func() []string {
		h.bs.FlushSettingsNotice(ctx, "rest-settings")
		return settingsNotices(t, h.bs, "rest-settings")
	}

	require.Equal(t, http.StatusOK, putJSON(t, base+"/subscribers/Rev/review-settings", `{"reviews_only":true,"review_areas":["go","ui"]}`))
	got := told()
	require.Len(t, got, 1)
	assert.Equal(t, "@Orchestrator The Operator changed review.Rev.areas: (none) -> go, ui; review.Rev.reviews_only: off -> on.", got[0])

	created := postJSON(t, base+"/working-mode/presets", map[string]string{"id": "mine", "name": "Mine", "instructions": "Work in small steps"})
	created.Body.Close()
	require.Equal(t, http.StatusCreated, created.StatusCode)
	got = told()
	require.Len(t, got, 2)
	assert.Contains(t, got[1], "workflow_preset.mine.instructions: (none) -> Work in small steps")
	assert.Contains(t, got[1], "workflow_preset.mine.name: (none) -> Mine")
	require.Equal(t, http.StatusOK, putJSON(t, base+"/working-mode/presets/mine", `{"name":"Mine","instructions":"Work in big steps"}`))
	got = told()
	require.Len(t, got, 3)
	assert.Contains(t, got[2], "workflow_preset.mine.instructions: Work in small steps -> Work in big steps")

	// the guide roster: one setting per Hub user
	saveRoster := func(body string) {
		t.Helper()
		req := httptest.NewRequest(http.MethodPut, "/api/board/rest-settings/guide-roster", strings.NewReader(body))
		req = asPerson(withActor(req, Actor{Kind: ActorOperator, Name: "Operator"}))
		rc := chi.NewRouteContext()
		rc.URLParams.Add("project", "rest-settings")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
		w := httptest.NewRecorder()
		h.GuideRoster(w, req)
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	}
	saveRoster(`{"roster":{"hub-user-1234abcd":"Pat"}}`)
	got = told()
	require.Len(t, got, 4, "%v", got)
	assert.Contains(t, got[3], "guide_roster.hub-user-1234abcd: (none) -> Pat")
	// a save that changes nothing tells nothing
	saveRoster(`{"roster":{"hub-user-1234abcd":"Pat"}}`)
	assert.Len(t, told(), 4)
}

// The window is real (a timer, not only the explicit flush): two saves inside it are one message, a save after it is another.
func TestTwoSavesInsideTheWindowAreOneMessageAndOneAfterItIsAnother(t *testing.T) {
	old := board.SettingsNoticeDelay
	board.SettingsNoticeDelay = 250 * time.Millisecond
	t.Cleanup(func() { board.SettingsNoticeDelay = old })
	server, h := setupBoardTestServer(t)
	base := server.URL + "/api/board/window-team"
	postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Lead", "job_title": "Orchestrator"}).Body.Close()
	waitFor := func(n int) []string {
		deadline := time.Now().Add(5 * time.Second)
		for {
			got := settingsNotices(t, h.bs, "window-team")
			if len(got) >= n || time.Now().After(deadline) {
				return got
			}
			time.Sleep(25 * time.Millisecond) // sleep-ok: a test waits for a timer to fire, with a deadline
		}
	}
	require.Equal(t, http.StatusOK, putJSON(t, base+"/settings", `{"subscriber_id":"Operator","max_open_goals":3}`))
	require.Equal(t, http.StatusOK, putJSON(t, base+"/settings", `{"subscriber_id":"Operator","max_open_goals":6}`))
	got := waitFor(1)
	require.Len(t, got, 1, "two saves inside the window are one message")
	assert.Equal(t, "@Orchestrator The Operator changed max_open_goals: 0 -> 6.", got[0])
	time.Sleep(400 * time.Millisecond) // sleep-ok: past the window, to show no second message follows from the first two
	assert.Len(t, settingsNotices(t, h.bs, "window-team"), 1)
	require.Equal(t, http.StatusOK, putJSON(t, base+"/settings", `{"subscriber_id":"Operator","max_open_goals":9}`))
	got = waitFor(2)
	require.Len(t, got, 2, "a save after the window is its own message")
	assert.Equal(t, "@Orchestrator The Operator changed max_open_goals: 6 -> 9.", got[1])
}

// The two derived flags of the cross-team switches never name themselves, a value that reads as "Dev:" mentions no one, a control character is gone, and a title with one is cleaned.
func TestTheNoticeLeavesOutDerivedFlagsAndMakesQuotedValuesSafe(t *testing.T) {
	holdSettingsNotices(t)
	server, h := setupBoardTestServer(t)
	base := server.URL + "/api/board/safe-team"
	postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Lead", "job_title": "Orchestrator"}).Body.Close()
	postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Dev", "job_title": "Developer"}).Body.Close()
	ctx := context.Background()
	require.Equal(t, http.StatusOK, putJSON(t, base+"/settings", `{"subscriber_id":"Operator","cross_team_messaging":false,"cross_team_artifacts":false}`))
	h.bs.FlushSettingsNotice(ctx, "safe-team")
	got := settingsNotices(t, h.bs, "safe-team")
	require.Len(t, got, 1)
	assert.Contains(t, got[0], "cross_team_messaging: on -> off")
	assert.NotContains(t, got[0], "_set", "the derived 'set' flags are not told")

	h.bs.NoteSettingsChange("safe-team", "The Operator", "Operator", []board.SettingChange{{Name: "note", Old: "a", New: "Dev: do this \x1b[31mred\x1b[0m now"}})
	h.bs.FlushSettingsNotice(ctx, "safe-team")
	got = settingsNotices(t, h.bs, "safe-team")
	require.Len(t, got, 2)
	assert.NotContains(t, got[1], "\x1b", "no control character reaches the board")
	assert.Equal(t, []string{"Lead"}, h.bs.NotifiedBy(ctx, "safe-team", board.SettingsSender, got[1]), "'Dev:' does not mention Dev")
	// a title typed with a control character is cleaned before it is put in front of the message
	postJSON(t, server.URL+"/api/board/title-team/subscribe", map[string]string{"subscriber_id": "Lead", "job_title": "Orchestrator\x1b[31m"}).Body.Close()
	h.bs.NoteSettingsChange("title-team", "The Operator", "Operator", []board.SettingChange{{Name: "x", Old: "a", New: "b"}})
	h.bs.FlushSettingsNotice(ctx, "title-team")
	titled := settingsNotices(t, h.bs, "title-team")
	for _, c := range titled {
		assert.NotContains(t, c, "\x1b")
		assert.True(t, strings.HasPrefix(c, "@Orchestrator"), c)
	}
}

// A Hub settings change that cannot be recorded is undone, and the Orchestrator is not left told of a change that did not stay: the undo is noted against the change in the same window.
func TestAHubSettingsChangeThatIsUndoneIsNotToldToTheOrchestrator(t *testing.T) {
	holdSettingsNotices(t)
	dbPath := t.TempDir() + "/board_test.db"
	bs, err := boardtest.Open(dbPath)
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h := NewBoardHandler(bs)
	t.Cleanup(h.WaitBackground)
	withLabel(t, ownerLabel, nil)
	h.hubCrossTeamLock = func(context.Context) (bool, error) { return true, nil }
	ctx := context.Background()
	_, err = bs.Subscribe(ctx, "team", "Lead", "Orchestrator", "lead-session", nil, "all")
	require.NoError(t, err)
	code, _ := boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","cross_team_messaging":false}`, nil)
	require.Equal(t, 200, code)
	bs.FlushSettingsNotice(ctx, "team")
	require.Len(t, settingsNotices(t, bs, "team"), 1, "the first change is told")

	raw, err := sql.Open("sqlite", dbPath)
	require.NoError(t, err)
	t.Cleanup(func() { raw.Close() })
	_, err = raw.Exec(`CREATE TRIGGER no_hub_actions BEFORE INSERT ON hub_operator_actions BEGIN SELECT RAISE(ABORT, 'cannot record'); END`)
	require.NoError(t, err)
	code, out := boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","cross_team_messaging":true,"cross_team_servers":["srv_abc"],"require_goal":true}`, ownerHeaders(ownerLabel))
	require.Equal(t, 500, code)
	require.Equal(t, "record_failed", out["code"])
	bs.FlushSettingsNotice(ctx, "team")
	assert.Len(t, settingsNotices(t, bs, "team"), 1, "the change that was undone is not told: the undo cancels it")
}
