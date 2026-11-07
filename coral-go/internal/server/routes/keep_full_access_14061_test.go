package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// "Keep Full access when this agent restarts" (#14061): the Operator's per-Codex-agent choice, applied on every relaunch after the capabilities, logged, cleared by a capabilities edit.

func keepCall(t *testing.T, r *wakeRig, name, sid, agentType string, on bool) int {
	t.Helper()
	rt := chi.NewRouter()
	rt.Post("/api/sessions/live/{name}/keep-full-access", r.h.KeepFullAccessOpt)
	body := `{"session_id":"` + sid + `","agent_type":"` + agentType + `","on":` + map[bool]string{true: "true", false: "false"}[on] + `}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+name+"/keep-full-access", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	rt.ServeHTTP(rec, req)
	return rec.Code
}

// A wake (the same code an auto-wake and the update restart run) types Full access's flag with the choice on, whatever the narrow capabilities say, and the narrowing words go away.
func TestAWakeKeepsFullAccessWhenTheOperatorAsked(t *testing.T) {
	const team, name = "team-14061", "Dev Keep"
	for _, keep := range []bool{false, true} {
		r := newWakeRig(t)
		ctx := context.Background()
		logs := captureSlog(t)
		codexSleeper(t, r, sid(61), name, team, store.SleepReasonCoralStopped, "never", "danger-full-access")
		if keep {
			require.Equal(t, http.StatusOK, keepCall(t, r, naming.SessionName("codex", sid(61)), sid(61), "codex", true))
		}
		r.h.AutoWakeAfterRestart(ctx)
		cmds := strings.Join(r.h.terminal.(*mockSessionTerminal).sentCommands(), "\n")
		if keep {
			require.Contains(t, cmds, "--dangerously-bypass-approvals-and-sandbox")
			require.Contains(t, logs(), "[keep-full-access] set")
			require.Contains(t, logs(), "[keep-full-access] applied")
			require.Equal(t, []string{"@Dev Keep " + AutoWakeNotice}, boardTexts(t, r, team), "nothing was narrowed: the plain notice")
		} else {
			require.NotContains(t, cmds, "--dangerously-bypass-approvals-and-sandbox")
			require.NotContains(t, logs(), "[keep-full-access] applied")
		}
	}
}

func TestTheChoiceIsCodexOnlyAndNeedsTheExactTarget(t *testing.T) {
	r := newWakeRig(t)
	r.add(sid(62), "Dev Claude", "", "", false)
	require.Equal(t, http.StatusBadRequest, keepCall(t, r, naming.SessionName("claude", sid(62)), sid(62), "claude", true))
	on, err := r.ss.KeepFullAccess(context.Background(), sid(62))
	require.NoError(t, err)
	require.False(t, on)
}

// An edit of the capabilities is the person changing what the agent may do: a later relaunch with new capabilities does not keep Full access, and the choice is gone.
func TestEditedCapabilitiesEndTheChoice(t *testing.T) {
	r := newWakeRig(t)
	ctx := context.Background()
	codexSleeper(t, r, sid(63), "Dev Edit", "team-14061c", store.SleepReasonCoralStopped, "never", "danger-full-access")
	require.Equal(t, http.StatusOK, keepCall(t, r, naming.SessionName("codex", sid(63)), sid(63), "codex", true))
	ls, err := r.ss.GetLiveSession(ctx, sid(63))
	require.NoError(t, err)
	edited := `{"allow":["file_read"]}`
	require.False(t, r.h.keepFullAccessForRelaunch(ctx, "codex", sid(63), "restart", ls.Capabilities, &edited))
	require.True(t, r.h.keepFullAccessForRelaunch(ctx, "codex", sid(63), "restart", ls.Capabilities, ls.Capabilities))
}

// The row says it for the Operator and not for an agent's token.
func TestTheRowShowsTheChoiceToTheOperatorAndNotToAnAgent(t *testing.T) {
	server, h, _, ss := setupSessionsTestServer(t)
	_ = h
	_ = ss
	_ = server
	rows := []map[string]any{{"keep_full_access": true, "codex_live_mode": map[string]any{}, "codex_relaunch_narrows": map[string]any{}, "name": "x"}}
	req := httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil)
	dropOwnerOnlyCodexFields(req, rows)
	require.Contains(t, rows[0], "keep_full_access", "the Operator's request keeps them")
	scoped := withoutPersonText(rows[0])
	require.Nil(t, scoped["keep_full_access"])
	require.Nil(t, scoped["codex_live_mode"])
	require.Nil(t, scoped["codex_relaunch_narrows"])
	require.Equal(t, "x", scoped["name"])
}

// Setting and clearing it are the Operator's clicks and are in the Activity record (Security's SHOULD on #14061): one row each, with the note on or off, for a person only; a call that changes nothing, or
// that an agent's token makes, writes none. The handler asks the recorder, so the row is written after the 2xx.
func TestSettingAndClearingItAreActivityRows(t *testing.T) {
	r := newWakeRig(t)
	ctx := context.Background()
	codexSleeper(t, r, sid(64), "Dev Act", "team-14061d", store.SleepReasonCoralStopped, "never", "danger-full-access")
	name := naming.SessionName("codex", sid(64))
	as := func(person bool) func(on bool) int {
		rt := chi.NewRouter()
		rt.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if person {
					req = asPerson(req)
				} else {
					req.Header.Set(store.SessionTokenHeader, "agent-token-for-test")
				}
				next.ServeHTTP(w, req)
			})
		})
		rt.Use(ActivityRecorder(r.h.bs))
		rt.Post("/api/sessions/live/{name}/keep-full-access", r.h.KeepFullAccessOpt)
		return func(on bool) int {
			body, _ := json.Marshal(map[string]any{"session_id": sid(64), "agent_type": "codex", "on": on})
			req := httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+name+"/keep-full-access", strings.NewReader(string(body)))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			rt.ServeHTTP(rec, req)
			return rec.Code
		}
	}
	rows := func() []board.OperatorAction {
		page, _, err := r.h.bs.ActivityPage(ctx, board.ActivityFilter{Limit: board.ActivityMaxLimit})
		require.NoError(t, err)
		return page
	}
	person := as(true)
	require.Equal(t, http.StatusOK, person(true))
	require.Equal(t, http.StatusOK, person(true), "turning it on again changes nothing")
	require.Equal(t, http.StatusOK, person(false))
	got := rows()
	require.Len(t, got, 2, "one row for the set, one for the clear, none for the repeat")
	notes := []string{got[0].Note, got[1].Note}
	require.ElementsMatch(t, []string{"on", "off"}, notes)
	for _, row := range got {
		require.Equal(t, board.ActKeepFullAccess, row.Action)
		require.Equal(t, "agent", row.ItemKind)
	}
	require.Equal(t, http.StatusOK, as(false)(true))
	require.Len(t, rows(), 2, "an agent's token writes no Activity row")
}
