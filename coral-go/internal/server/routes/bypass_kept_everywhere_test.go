package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/store"
)

// #12718 (both operators: an agent launched with bypass permissions comes back in Claude's auto mode after a restart, resume or wake, and stops for prompts): the mode the person chose at launch is the
// mode of every later start of that agent. The saved default in Settings is Auto here, as on the Operator's machine: nothing may fall back to it for an agent that was launched with bypass.
func claudeRig(t *testing.T) *agyTestRig {
	t.Helper()
	rig := setupAgyTestRig(t)
	fake := stubScript(t, filepath.Join(t.TempDir(), "mock-claude"), "#!/bin/sh\nexit 0\n")
	require.NoError(t, rig.ss.SetSetting(context.Background(), agent.CLIPathSettingKey(at.Claude), fake))
	require.NoError(t, rig.ss.SetSetting(context.Background(), "default_permission_mode", "auto"))
	return rig
}

func (r *agyTestRig) post(t *testing.T, path string, body map[string]any) map[string]any {
	t.Helper()
	b, _ := json.Marshal(body)
	rec := httptest.NewRecorder()
	r.router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, bytes.NewReader(b)))
	require.Equal(t, http.StatusOK, rec.Code, path+" "+rec.Body.String())
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return out
}

// modeOf is the --permission-mode values on a launch line, in order.
func modeOf(cmd string) []string {
	var modes []string
	f := strings.Fields(cmd)
	for i, w := range f {
		if w == "--permission-mode" && i+1 < len(f) {
			modes = append(modes, strings.Trim(f[i+1], `'"`))
		}
		if w == "--dangerously-skip-permissions" {
			modes = append(modes, "bypassPermissions")
		}
	}
	return modes
}

func (r *agyTestRig) wake(t *testing.T, sid string) string {
	t.Helper()
	ctx := context.Background()
	require.NoError(t, r.ss.SetSessionSleeping(ctx, sid, true))
	ls, err := r.ss.GetLiveSession(ctx, sid)
	require.NoError(t, err)
	require.NoError(t, r.h.wakeExistingSession(ctx, ls))
	return lastSentCommand(r.term)
}

func TestABypassAgentKeepsBypassOnEveryWayItStartsAgain(t *testing.T) {
	launches := map[string]map[string]any{
		"the mode as its own flags": {"flags": []string{"--permission-mode", "bypassPermissions"}},
		"the skip-permissions flag": {"flags": []string{"--dangerously-skip-permissions"}},
	}
	for name, extra := range launches {
		extra := extra
		t.Run(name, func(t *testing.T) {
			rig := claudeRig(t)
			body := map[string]any{"agent_type": at.Claude, "working_dir": rig.workdir}
			for k, v := range extra {
				body[k] = v
			}
			out := rig.post(t, "/api/sessions/launch", body)
			sid, _ := out["session_id"].(string)
			require.NotEmpty(t, sid, out)
			sname := naming.SessionName(at.Claude, sid)
			isBypass := func(step, cmd string) {
				t.Helper()
				m := modeOf(cmd)
				require.NotEmpty(t, m, "%s: no mode on the line: %s", step, cmd)
				for _, x := range m {
					assert.Equal(t, "bypassPermissions", x, "%s: %s", step, cmd)
				}
				assert.NotContains(t, cmd, "auto", step)
			}
			isBypass("launch", lastSentCommand(rig.term))
			isBypass("wake", rig.wake(t, sid))
			// the recovery after a lost terminal server: the row is asleep for that reason and recoverAgent wakes it
			require.NoError(t, rig.ss.SetSessionSleepingFor(context.Background(), sid, store.SleepReasonTerminalGone))
			asleep, err := rig.ss.GetLiveSession(context.Background(), sid)
			require.NoError(t, err)
			require.Equal(t, 1, asleep.IsSleeping, "asleep for the lost terminal")
			rig.h.recoverAgent(context.Background(), sid)
			awake, err := rig.ss.GetLiveSession(context.Background(), sid)
			require.NoError(t, err)
			require.Equal(t, 0, awake.IsSleeping, "the recovery woke the agent")
			isBypass("recovery after the terminal server was lost", lastSentCommand(rig.term))
			require.NoError(t, rig.term.CreateSession(context.Background(), sname, rig.workdir))
			rest := rig.post(t, "/api/sessions/live/"+sname+"/restart", map[string]any{"session_id": sid, "agent_type": at.Claude})
			isBypass("restart", lastSentCommand(rig.term))
			if next, _ := rest["session_id"].(string); next != "" {
				sid, sname = next, naming.SessionName(at.Claude, next)
			}
			isBypass("wake after the restart", rig.wake(t, sid))
			require.NoError(t, rig.term.CreateSession(context.Background(), sname, rig.workdir))
			res := rig.post(t, "/api/sessions/live/"+sname+"/resume", map[string]any{"session_id": sid, "current_session_id": sid, "agent_type": at.Claude})
			isBypass("resume", lastSentCommand(rig.term))
			if next, _ := res["session_id"].(string); next != "" {
				sid = next
			}
			isBypass("wake after the resume", rig.wake(t, sid))
			ls, err := rig.ss.GetLiveSession(context.Background(), sid)
			require.NoError(t, err)
			require.NotNil(t, ls.PermissionMode, "the row still records the mode")
			assert.Equal(t, "bypassPermissions", *ls.PermissionMode)
		})
	}
}

// A row from before modes were recorded keeps what its flags say, and one with neither is not given the saved default (Auto here) by a wake or a resume: restart already starts it in Default (#10297).
func TestALegacyRowKeepsItsFlagsModeAndIsNeverSilentlyAuto(t *testing.T) {
	cases := []struct {
		name  string
		flags []string
		mode  string
		want  string
	}{
		{"flags only, bypass", []string{"--permission-mode", "bypassPermissions"}, "", "bypassPermissions"},
		{"flags only, skip-permissions", []string{"--dangerously-skip-permissions"}, "", "bypassPermissions"},
		{"mode only", nil, "bypassPermissions", "bypassPermissions"},
		{"neither recorded", nil, "", "default"},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			rig := claudeRig(t)
			ctx := context.Background()
			sid := "77777777-4444-5555-6666-000000000001"
			sname := naming.SessionName(at.Claude, sid)
			reg := func() {
				require.NoError(t, rig.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: at.Claude, AgentName: "Frontend Dev", WorkingDir: rig.workdir,
					Flags: store.MarshalFlags(c.flags), PermissionMode: ptr.NonEmpty(c.mode)}))
			}
			check := func(step, cmd string) {
				t.Helper()
				m := modeOf(cmd)
				require.NotEmpty(t, m, "%s: %s", step, cmd)
				assert.Equal(t, c.want, m[len(m)-1], "%s: %s", step, cmd)
				assert.NotContains(t, cmd, " auto", step)
			}
			reg()
			check("wake", rig.wake(t, sid))
			require.NoError(t, rig.term.CreateSession(ctx, sname, rig.workdir))
			rest := rig.post(t, "/api/sessions/live/"+sname+"/restart", map[string]any{"session_id": sid, "agent_type": at.Claude})
			check("restart", lastSentCommand(rig.term))
			if next, _ := rest["session_id"].(string); next != "" {
				sid, sname = next, naming.SessionName(at.Claude, next)
			}
			require.NoError(t, rig.term.CreateSession(ctx, sname, rig.workdir))
			rig.post(t, "/api/sessions/live/"+sname+"/resume", map[string]any{"session_id": sid, "current_session_id": sid, "agent_type": at.Claude})
			check("resume", lastSentCommand(rig.term))
		})
	}
}

// A row with no mode and no permission flag takes the mode its chat STARTED in from Claude's transcript (the first entry's permissionMode), on every way it starts again, and records it. A transcript that
// started in Default or Auto gives that, never more: nothing widens a row to Bypass that was not started in it.
func TestAnUnrecordedRowTakesTheModeItsTranscriptStartedIn(t *testing.T) {
	for _, started := range []string{"bypassPermissions", "auto", "default", "plan"} {
		started := started
		t.Run(started, func(t *testing.T) {
			rig := claudeRig(t)
			ctx := context.Background()
			sid := "88888888-4444-5555-6666-000000000001"
			sname := naming.SessionName(at.Claude, sid)
			file := filepath.Join(t.TempDir(), "transcript.jsonl")
			line := `{"type":"user","cwd":` + jsonString(rig.workdir) + `,"permissionMode":"` + started + `","message":{"role":"user","content":"hi"}}` + "\n" +
				`{"type":"user","cwd":` + jsonString(rig.workdir) + `,"permissionMode":"bypassPermissions","message":{"role":"user","content":"later"}}` + "\n"
			require.NoError(t, os.WriteFile(file, []byte(line), 0o600))
			require.NoError(t, rig.ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: sid, SourceType: at.Claude, SourceFile: file}))
			require.NoError(t, rig.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: at.Claude, AgentName: "Frontend Dev", WorkingDir: rig.workdir}))
			check := func(step, cmd string) {
				t.Helper()
				m := modeOf(cmd)
				require.NotEmpty(t, m, "%s: %s", step, cmd)
				assert.Equal(t, started, m[len(m)-1], "%s: the chat started in %s: %s", step, started, cmd)
			}
			check("wake", rig.wake(t, sid))
			ls, err := rig.ss.GetLiveSession(ctx, sid)
			require.NoError(t, err)
			require.NotNil(t, ls.PermissionMode, "the mode it started in is recorded by the wake")
			assert.Equal(t, started, *ls.PermissionMode)
			// restart and resume of a row that has not been woken: clear the record to see each read the transcript itself
			clear := func() {
				_, err := rig.h.ss.DB().ExecContext(ctx, "UPDATE live_sessions SET permission_mode = NULL WHERE session_id = ?", sid)
				require.NoError(t, err)
			}
			clear()
			require.NoError(t, rig.term.CreateSession(ctx, sname, rig.workdir))
			rest := rig.post(t, "/api/sessions/live/"+sname+"/restart", map[string]any{"session_id": sid, "agent_type": at.Claude})
			check("restart", lastSentCommand(rig.term))
			next, _ := rest["session_id"].(string)
			require.NotEmpty(t, next)
			ls, err = rig.ss.GetLiveSession(ctx, next)
			require.NoError(t, err)
			require.NotNil(t, ls.PermissionMode)
			assert.Equal(t, started, *ls.PermissionMode, "the restarted row records it")
		})
	}
}

// Security's pin on #12718: the transcript's permissionMode goes into a launch line, so only a known mode is taken from it. A junk word, a quote, a backtick or a newline is no mode: the row starts in Default.
func TestOnlyAKnownModeIsTakenFromATranscript(t *testing.T) {
	for _, bad := range []string{"bypassPermissionz", "auto'; touch /tmp/x; '", "auto`id`", "auto\nbypassPermissions", "$(id)", " auto", "AUTO", "--dangerously-skip-permissions"} {
		assert.Equal(t, "", startModeOf(bad), "%q is no mode", bad)
	}
	for _, good := range []string{"default", "plan", "acceptEdits", "auto", "bypassPermissions", "dontAsk"} {
		assert.Equal(t, good, startModeOf(good))
	}
	assert.Equal(t, "", startModeOf(""))
}

// The same through a real transcript and the wake: each odd value gives Default on the launch line, and is not recorded.
func TestATranscriptWithAnOddModeWakesInDefaultAndRecordsNothing(t *testing.T) {
	for name, odd := range map[string]string{"junk": "bypassPermissionz", "a quote": "auto'; touch /tmp/x; '", "a backtick": "auto`id`", "a newline": "auto\\nbypassPermissions"} {
		odd := odd
		t.Run(name, func(t *testing.T) {
			rig := claudeRig(t)
			ctx := context.Background()
			sid := "99999999-4444-5555-6666-000000000001"
			file := filepath.Join(t.TempDir(), "transcript.jsonl")
			require.NoError(t, os.WriteFile(file, []byte(`{"type":"user","cwd":`+jsonString(rig.workdir)+`,"permissionMode":"`+odd+`","message":{"role":"user","content":"hi"}}`+"\n"), 0o600))
			require.NoError(t, rig.ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: sid, SourceType: at.Claude, SourceFile: file}))
			require.NoError(t, rig.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: at.Claude, AgentName: "Frontend Dev", WorkingDir: rig.workdir}))
			cmd := rig.wake(t, sid)
			m := modeOf(cmd)
			require.NotEmpty(t, m, cmd)
			assert.Equal(t, "default", m[len(m)-1], cmd)
			assert.NotContains(t, cmd, "touch /tmp/x")
			assert.NotContains(t, cmd, "`id`")
			ls, err := rig.ss.GetLiveSession(ctx, sid)
			require.NoError(t, err)
			assert.True(t, ls.PermissionMode == nil || *ls.PermissionMode == "", "nothing odd is recorded")
		})
	}
}

// QA's SHOULD 4: the resume path reads the transcript too and records the mode on the resumed row.
func TestAResumeTakesAndRecordsTheModeItsTranscriptStartedIn(t *testing.T) {
	rig := claudeRig(t)
	ctx := context.Background()
	sid := "aaaaaaaa-4444-5555-6666-000000000002"
	sname := naming.SessionName(at.Claude, sid)
	file := filepath.Join(t.TempDir(), "transcript.jsonl")
	require.NoError(t, os.WriteFile(file, []byte(`{"type":"user","cwd":`+jsonString(rig.workdir)+`,"permissionMode":"bypassPermissions","message":{"role":"user","content":"hi"}}`+"\n"), 0o600))
	require.NoError(t, rig.ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: sid, SourceType: at.Claude, SourceFile: file}))
	require.NoError(t, rig.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: at.Claude, AgentName: "Frontend Dev", WorkingDir: rig.workdir}))
	require.NoError(t, rig.term.CreateSession(ctx, sname, rig.workdir))
	out := rig.post(t, "/api/sessions/live/"+sname+"/resume", map[string]any{"session_id": sid, "current_session_id": sid, "agent_type": at.Claude})
	m := modeOf(lastSentCommand(rig.term))
	require.NotEmpty(t, m)
	assert.Equal(t, "bypassPermissions", m[len(m)-1], "the resume keeps the mode the chat started in")
	next, _ := out["session_id"].(string)
	if next == "" {
		next = sid
	}
	ls, err := rig.ss.GetLiveSession(ctx, next)
	require.NoError(t, err)
	require.NotNil(t, ls.PermissionMode, "the resumed row records it")
	assert.Equal(t, "bypassPermissions", *ls.PermissionMode)
}
