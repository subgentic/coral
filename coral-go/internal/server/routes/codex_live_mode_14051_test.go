package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// A Codex agent's row says the mode it runs in now (#14051), read from its rollout's newest turn_context (display only: the agent writes that file), and says when a relaunch (a wake, a
// restart, an auto-wake) would start it in something narrower than that, from the same launch settings the builder uses. A row for which nothing can be said has both keys, null.
// listedRow is the row the HTTP list answers for a session, whole (httpAndWSState keeps only the state fields).
func listedRow(t *testing.T, server *httptest.Server, sid string) map[string]any {
	t.Helper()
	resp, err := http.Get(server.URL + "/api/sessions/live")
	require.NoError(t, err)
	defer resp.Body.Close()
	var list []map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&list))
	for _, s := range list {
		if s["session_id"] == sid {
			return s
		}
	}
	require.FailNow(t, "session missing from the list", sid)
	return nil
}

func TestACodexRowSaysItsLiveModeAndWhenARelaunchWouldNarrowIt(t *testing.T) {
	r := newCodexRig(t)
	ctx := context.Background()
	narrow := `{"allow":["file_read","file_write","web_access","shell:npm *"]}`
	flags := `["--dangerously-bypass-approvals-and-sandbox"]`
	bypass := "bypassPermissions"
	store1 := func(flags, caps, mode *string) {
		t.Helper()
		require.NoError(t, r.h.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: r.sid, AgentType: "codex", AgentName: "cx", WorkingDir: "/tmp/project", Flags: flags, Capabilities: caps, PermissionMode: mode}))
	}
	row := func() map[string]any { return listedRow(t, r.server, r.sid) }
	turn := func(approval, sandbox string) {
		t.Helper()
		f, err := os.OpenFile(r.rollout, os.O_APPEND|os.O_WRONLY, 0o600)
		require.NoError(t, err)
		defer f.Close()
		_, err = f.WriteString(`{"type":"turn_context","payload":{"approval_policy":"` + approval + `","approvals_reviewer":"user","sandbox_policy":{"type":"` + sandbox + `"}}}` + "\n")
		require.NoError(t, err)
	}

	store1(&flags, &narrow, &bypass) // launched narrow: the three agents of #14028
	turn("never", "danger-full-access")
	s := row()
	require.Equal(t, map[string]any{"approval": "never", "sandbox": "danger-full-access", "label": "Full access"}, s["codex_live_mode"])
	require.Equal(t, map[string]any{"live": "Full access", "launch": "Workspace write, asks when needed"}, s["codex_relaunch_narrows"], "Full access now, a relaunch gives the capability set")

	turn("on-request", "workspace-write") // the person set it back, or never widened it: nothing to say
	s = row()
	require.Equal(t, map[string]any{"approval": "on-request", "sandbox": "workspace-write", "label": "Workspace write, asks when needed"}, s["codex_live_mode"])
	require.Nil(t, s["codex_relaunch_narrows"], "equal to what a relaunch gives")
	require.Contains(t, s, "codex_relaunch_narrows", "the key is always there: the dashboard merges rows, so an omitted key would keep a warning that no longer holds")

	turn("never", "read-only")
	s = row()
	require.Equal(t, "Read-only", s["codex_live_mode"].(map[string]any)["label"])
	require.Nil(t, s["codex_relaunch_narrows"], "a relaunch that WIDENS is not a warning of this kind")

	store1(nil, nil, nil) // nothing stored: the CLI's own config decides on a relaunch, so nothing can be said to be narrower
	turn("never", "danger-full-access")
	s = row()
	require.Equal(t, "Full access", s["codex_live_mode"].(map[string]any)["label"])
	require.Nil(t, s["codex_relaunch_narrows"])
}

// Only Codex rows carry it, and a Codex row whose rollout has no turn_context yet says nothing about a mode.
func TestOnlyACodexRowWithATurnContextCarriesALiveMode(t *testing.T) {
	r := newCodexRig(t)
	ctx := context.Background()
	require.NoError(t, os.WriteFile(r.rollout, []byte(`{"type":"event_msg","payload":{"type":"task_started"}}`+"\n"), 0o600))
	s := listedRow(t, r.server, r.sid)
	require.Contains(t, s, "codex_live_mode")
	require.Nil(t, s["codex_live_mode"], "no turn_context: no mode is invented")
	require.Nil(t, s["codex_relaunch_narrows"])

	claude := "dddddddd-6645-4000-8000-000000000002"
	require.NoError(t, r.h.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: claude, AgentType: "claude", AgentName: "cl", WorkingDir: "/tmp/project"}))
	r.mock.addSession("claude-"+claude, "/tmp/project")
	c := listedRow(t, r.server, claude)
	require.Nil(t, c["codex_live_mode"])
	require.Nil(t, c["codex_relaunch_narrows"])
}

// codexSleeper registers a Codex agent asleep for reason on a team's board, launched narrow (the capability set of #14028's three agents, a stored bypass the capabilities narrow), with a rollout whose
// newest turn_context is the live mode given.
func codexSleeper(t *testing.T, r *wakeRig, id, name, team, reason, approval, sandbox string) {
	t.Helper()
	ctx := context.Background()
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)
	require.NoError(t, r.ss.SetSetting(ctx, "cli_path_codex", stubCLI(t)))
	dir := t.TempDir()
	narrow, flags, mode := `{"allow":["file_read","file_write","web_access","shell:npm *"]}`, `["--dangerously-bypass-approvals-and-sandbox"]`, "bypassPermissions"
	disp := name
	require.NoError(t, r.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentName: name, AgentType: "codex", WorkingDir: dir, DisplayName: &disp, Flags: &flags, Capabilities: &narrow, PermissionMode: &mode}))
	require.NoError(t, r.ss.SetSessionSleepingFor(ctx, id, reason))
	_, err := r.h.db.ExecContext(ctx, "UPDATE live_sessions SET board_name = ? WHERE session_id = ?", team, id)
	require.NoError(t, err)
	_, err = r.h.bs.Subscribe(ctx, team, naming.SubscriberID(name, "codex"), name, naming.SessionName("codex", id), nil, "mentions")
	require.NoError(t, err)
	rolloutDir := filepath.Join(codexHome, "sessions", "2026", "11", "06")
	require.NoError(t, os.MkdirAll(rolloutDir, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(rolloutDir, "rollout-2026-11-06T10-00-00-"+id+".jsonl"),
		[]byte(`{"type":"turn_context","payload":{"approval_policy":"`+approval+`","approvals_reviewer":"user","sandbox_policy":{"type":"`+sandbox+`"}}}`+"\n"), 0o600))
}

func boardTexts(t *testing.T, r *wakeRig, team string) []string {
	t.Helper()
	msgs, err := r.h.bs.ListMessages(context.Background(), team, 50, 0, 0)
	require.NoError(t, err)
	out := make([]string, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, m.Content)
	}
	return out
}

// The restart-time auto-wake notice (#14051): a Codex agent that ran with Full access is started again with its launch set, and its board notice says so in one more sentence, with only words from
// a fixed set (the modes' names): nothing the agent's rollout says is copied into it.
func TestTheAutoWakeNoticeSaysWhenARelaunchNarrowedACodexAgent(t *testing.T) {
	const team, name = "team-14051", "Dev One"
	r := newWakeRig(t)
	ctx := context.Background()
	codexSleeper(t, r, sid(51), name, team, store.SleepReasonCoralStopped, "never", "danger-full-access")
	r.h.AutoWakeAfterRestart(ctx)
	texts := boardTexts(t, r, team)
	require.Len(t, texts, 1)
	require.Contains(t, texts[0], "@Dev One "+AutoWakeNotice+" ", "the fixed notice first, unchanged")
	require.Contains(t, texts[0], "Full access", "what it ran with")
	require.Contains(t, texts[0], "Workspace write, asks when needed", "what the relaunch gave it")

	// A Codex agent that already ran with the launch set gets the plain notice.
	r2 := newWakeRig(t)
	codexSleeper(t, r2, sid(52), name, team, store.SleepReasonCoralStopped, "on-request", "workspace-write")
	r2.h.AutoWakeAfterRestart(ctx)
	require.Equal(t, []string{"@Dev One " + AutoWakeNotice}, boardTexts(t, r2, team))
}

// A wake for a delivery (a message waits for an auto-asleep agent) posts the same sentence once, after the wake, to the agent's board.
func TestAWakeForADeliveryPostsTheNarrowingToTheBoard(t *testing.T) {
	const team, name = "team-14051b", "Dev Two"
	old := deliveryWakeGap
	deliveryWakeGap = 0
	t.Cleanup(func() { deliveryWakeGap = old })
	r := newWakeRig(t)
	ctx := context.Background()
	codexSleeper(t, r, sid(53), name, team, store.SleepReasonIdle, "never", "danger-full-access")
	require.True(t, r.h.WakeIdleFor(ctx, sid(53), true))
	texts := boardTexts(t, r, team)
	require.Len(t, texts, 1)
	require.Contains(t, texts[0], "@Dev Two ")
	require.Contains(t, texts[0], "Full access")
	require.Contains(t, texts[0], "Workspace write, asks when needed")
	require.NotContains(t, texts[0], AutoWakeNotice, "Coral did not restart: that sentence is not true here")

	// Nothing to say for an agent that ran with the launch set.
	r2 := newWakeRig(t)
	codexSleeper(t, r2, sid(54), name, team, store.SleepReasonIdle, "on-request", "workspace-write")
	require.True(t, r2.h.WakeIdleFor(ctx, sid(54), true))
	require.Empty(t, boardTexts(t, r2, team))
}
