package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/naming"
)

// #15727: the Codex approval mode the Operator chose, on every path that starts Codex again. For each pick New agent offers (Default, Plan, Auto, Bypass), with Full access on or off and with no, a
// narrowing (Shell with a deny list) and a widest (Shell, no deny) capability set, the flags the launch typed are read back after a plain restart, a restart that names the same mode, a wake and
// a resume. The mock CLI is a shell script that exits; nothing real is started and no auth file is read.

// codexPairOfCommand is what the typed command runs with: "bypass", or "<sandbox> <approval>" ("" for a part not typed: Codex's own config.toml then decides).
func codexPairOfCommand(cmd string) string {
	if strings.Contains(cmd, "--approve-for-me") {
		return "approve-for-me"
	}
	if strings.Contains(cmd, "--dangerously-bypass-approvals-and-sandbox") {
		return "bypass"
	}
	sb, ap := "", ""
	if m := regexp.MustCompile(`--sandbox[ =](\S+)`).FindStringSubmatch(cmd); m != nil {
		sb = m[1]
	}
	if m := regexp.MustCompile(`(?:-a|--ask-for-approval)[ =](\S+)`).FindStringSubmatch(cmd); m != nil {
		ap = m[1]
	}
	if sb == "" && ap == "" {
		return "(none: Codex's own config)"
	}
	return sb + " " + ap
}

type codexMatrixCase struct {
	pick  string
	flags []string
	mode  *string
	keep  bool
	caps  string // "", "narrow" (Shell with a deny list) or "wide" (Shell, no deny)
}

func (c codexMatrixCase) name() string {
	k := map[bool]string{false: "", true: "+full"}[c.keep]
	cp := ""
	if c.caps != "" {
		cp = "+caps:" + c.caps
	}
	return c.pick + k + cp
}

func TestCodexModeMatrix15727(t *testing.T) { codexModeMatrix(t, "") }

// #15780: on a Codex that has --approve-for-me (0.163.0 and later) Auto is Codex's own auto-review on every path that starts it again; every other pick, and Auto narrowed by a role's Shell rule, is as before.
func TestCodexModeMatrixAutoReview15780(t *testing.T) { codexModeMatrix(t, "0.163.0") }

// An older Codex keeps today's pair for Auto, on every path.
func TestCodexModeMatrixOlderCodexKeepsAutoPair15780(t *testing.T) { codexModeMatrix(t, "0.162.4") }

func codexModeMatrix(t *testing.T, version string) {
	if version != "" {
		old := agent.CodexVersionProbe
		agent.CodexVersionProbe = func(string) string { return version }
		t.Cleanup(func() { agent.CodexVersionProbe = old })
	}
	if runtime.GOOS == "windows" {
		t.Skip("the fake CLI is a shell script")
	}
	def := "default"
	picks := []codexMatrixCase{
		{pick: "default", mode: &def},
		{pick: "plan", flags: []string{"--sandbox", "read-only", "-a", "on-request"}},
		{pick: "auto", flags: []string{"--sandbox", "workspace-write", "-a", "never"}},
		{pick: "bypass", flags: []string{"--dangerously-bypass-approvals-and-sandbox"}},
	}
	capsJSON := map[string]map[string]any{
		"narrow": {"allow": []string{"shell"}, "deny": []string{"git_write"}},
		"wide":   {"allow": []string{"shell"}},
	}
	// What a launch types, by pick, Full access and capability set. Capabilities only narrow an explicit mode (#6425), and with Default (no explicit mode) Shell with no deny is Auto's pair (#6422).
	want := func(c codexMatrixCase) string {
		if c.keep {
			return "bypass"
		}
		switch c.pick + "/" + c.caps {
		case "default/":
			return "(none: Codex's own config)"
		case "default/narrow", "auto/narrow", "bypass/narrow":
			return "workspace-write on-request"
		case "auto/wide", "auto/":
			if agent.CodexVersionAtLeast(version, "0.163.0") {
				return "approve-for-me"
			}
			return "workspace-write never"
		case "default/wide":
			return "workspace-write never"
		case "plan/", "plan/narrow", "plan/wide":
			return "read-only on-request"
		}
		return "bypass" // bypass, and bypass with the widest capabilities
	}
	var table []string
	// One server for all 24 cases (a rig per case was most of the test's 36 s): each case launches its own sessions (their own ids and names), and what it reads back is the last command typed, so
	// nothing carries from one case to the next (#16528).
	rig := setupAgyTestRig(t)
	ctx := context.Background()
	fake := filepath.Join(t.TempDir(), "codex")
	require.NoError(t, os.WriteFile(fake, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	require.NoError(t, rig.ss.SetSetting(ctx, agent.CLIPathSettingKey(at.Codex), fake))
	for _, p := range picks {
		for _, keep := range []bool{false, true} {
			for _, caps := range []string{"", "narrow", "wide"} {
				c := p
				c.keep, c.caps = keep, caps
				post := func(path string, body map[string]any) map[string]any {
					b, _ := json.Marshal(body)
					rec := httptest.NewRecorder()
					rig.router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, bytes.NewReader(b)))
					require.Equal(t, http.StatusOK, rec.Code, path+" "+rec.Body.String())
					var res map[string]any
					_ = json.Unmarshal(rec.Body.Bytes(), &res)
					return res
				}
				body := map[string]any{"working_dir": rig.workdir, "agent_type": at.Codex}
				if c.mode != nil {
					body["permission_mode"] = *c.mode
				}
				if c.flags != nil {
					body["flags"] = c.flags
				}
				if c.keep {
					body["keep_full_access"] = true
				}
				if c.caps != "" {
					body["capabilities"] = capsJSON[c.caps]
				}
				res := post("/api/sessions/launch", body)
				sid := res["session_id"].(string)
				launched := codexPairOfCommand(lastSentCommand(rig.term))
				sess := naming.SessionName(at.Codex, sid)
				row := []string{c.name(), launched}

				ls, err := rig.ss.GetLiveSession(ctx, sid)
				require.NoError(t, err)
				stored := ""
				if ls.PermissionMode != nil {
					stored = *ls.PermissionMode
				}
				// wake first (the row is put to sleep, as Sleep does), on the launched session
				require.NoError(t, rig.ss.SetSessionSleeping(ctx, sid, true))
				ls, _ = rig.ss.GetLiveSession(ctx, sid)
				require.NoError(t, rig.h.wakeExistingSession(ctx, ls))
				woke := codexPairOfCommand(lastSentCommand(rig.term))

				// plain restart of the same session, then a restart that names the mode
				require.NoError(t, rig.term.CreateSession(ctx, sess, rig.workdir))
				r1 := post("/api/sessions/live/"+sess+"/restart", map[string]any{"session_id": sid, "agent_type": at.Codex})
				restarted := codexPairOfCommand(lastSentCommand(rig.term))
				sid2, _ := r1["session_id"].(string)
				if sid2 == "" {
					sid2 = sid
				}
				sess2 := naming.SessionName(at.Codex, sid2)
				_ = rig.term.CreateSession(ctx, sess2, rig.workdir)
				pm := stored
				if pm == "" {
					pm = "default"
				}
				rb := map[string]any{"session_id": sid2, "agent_type": at.Codex, "permission_mode": pm}
				if c.keep {
					rb["keep_full_access"] = true
				}
				r2 := post("/api/sessions/live/"+sess2+"/restart", rb)
				changed := codexPairOfCommand(lastSentCommand(rig.term))
				sid3, _ := r2["session_id"].(string)
				if sid3 == "" {
					sid3 = sid2
				}
				sess3 := naming.SessionName(at.Codex, sid3)
				_ = rig.term.CreateSession(ctx, sess3, rig.workdir)
				post("/api/sessions/live/"+sess3+"/resume", map[string]any{"session_id": sid3, "current_session_id": sid3, "agent_type": at.Codex})
				resumed := codexPairOfCommand(lastSentCommand(rig.term))
				for path, got := range map[string]string{"launch": launched, "restart": restarted, "restart naming the mode": changed, "wake": woke, "resume": resumed} {
					require.Equal(t, want(c), got, "%s: what %s types", c.name(), path)
				}
				row = append(row, "stored="+stored, "restart="+restarted, "restart+mode="+changed, "wake="+woke, "resume="+resumed)
				table = append(table, strings.Join(row, " | "))
			}
		}
	}
	t.Log("CODEX MATRIX (case | launch | stored | restart | restart+mode | wake | resume)\n" + strings.Join(table, "\n"))
}
