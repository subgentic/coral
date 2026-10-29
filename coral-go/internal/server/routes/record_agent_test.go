package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// recordTerminal is a terminal whose agents' notices are paused (nothing is recorded) and that can name and record a single foreground program per session. recorded says what was
// recorded; changed makes the foreground differ from what the Operator was shown.
type recordTerminal struct {
	*fgSessionTerminal
	cand     map[string]ptymanager.AgentCandidate // by session name: the single foreground program
	why      map[string]string                    // by session name: why there is no single program
	recorded map[string]ptymanager.AgentCandidate
	paused   map[string]bool
	readErr  map[string]error // by session name: the record's own read of the terminal fails
}

func (r *recordTerminal) AgentNoticeTarget(_ context.Context, name, _, _ string) (bool, bool, string, bool) {
	if r.paused[name] {
		return false, false, "the agent's process is not recorded", true
	}
	return true, false, "", true
}

func (r *recordTerminal) AgentCandidate(_ context.Context, name, _, _, _ string) (ptymanager.AgentCandidate, string, error) {
	if w := r.why[name]; w != "" {
		return ptymanager.AgentCandidate{}, w, nil
	}
	return r.cand[name], "", nil
}

func (r *recordTerminal) RecordAgent(_ context.Context, name, _, _ string, want ptymanager.AgentCandidate) (ptymanager.AgentCandidate, error) {
	cur := r.cand[name]
	if err := r.readErr[name]; err != nil {
		return ptymanager.AgentCandidate{}, err
	}
	if r.why[name] != "" {
		return ptymanager.AgentCandidate{}, ptymanager.ErrNoCandidate
	}
	if cur.PID != want.PID || cur.Start != want.Start {
		return ptymanager.AgentCandidate{}, ptymanager.ErrCandidateChanged
	}
	if cur.Under != "" && !want.AcknowledgeNested { // the real terminals check this in the same read as pid and start
		return ptymanager.AgentCandidate{}, &ptymanager.NeedsAcknowledgementError{Under: cur.Under}
	}
	r.recorded[name] = cur
	r.paused[name] = false
	return cur, nil
}

const (
	recordSIDa = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d"
	recordSIDb = "8b9c0d1e-2f3a-4b4c-8d5e-6f7a8b9c0d1e"
)

func recordFixture(t *testing.T) (srv string, term *recordTerminal, ss *store.SessionStore, nameA, nameB string) {
	t.Helper()
	_, handler, mock, ss := setupSessionsTestServer(t)
	term = &recordTerminal{fgSessionTerminal: newFGTerminal(mock), cand: map[string]ptymanager.AgentCandidate{}, why: map[string]string{}, recorded: map[string]ptymanager.AgentCandidate{}, paused: map[string]bool{}}
	handler.terminal = term
	r := chi.NewRouter()
	r.Get("/api/sessions/live/{sessionID}/agent-candidate", handler.AgentCandidate)
	r.Post("/api/sessions/live/{sessionID}/record-agent", handler.RecordAgent)
	r.Post("/api/sessions/record-agents", handler.RecordAgents)
	srv = httptestServer(t, r)
	nameA, nameB = naming.SessionName("claude", recordSIDa), naming.SessionName("codex", recordSIDb)
	for _, s := range []struct{ sid, typ string }{{recordSIDa, "claude"}, {recordSIDb, "codex"}} {
		require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: s.sid, AgentType: s.typ, AgentName: "repo-" + s.typ, WorkingDir: t.TempDir()}))
	}
	require.NoError(t, ss.SetSetting(context.Background(), "cli_path_claude", stubCLI(t)))
	require.NoError(t, ss.SetSetting(context.Background(), "cli_path_codex", stubCLI(t)))
	return srv, term, ss, nameA, nameB
}

func postRecordJSON(t *testing.T, url string, body any) (int, map[string]any) {
	t.Helper()
	b, err := json.Marshal(body)
	require.NoError(t, err)
	resp, err := http.Post(url, "application/json", bytes.NewReader(b))
	require.NoError(t, err)
	defer resp.Body.Close()
	var out map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	return resp.StatusCode, out
}

func getRecordJSON(t *testing.T, url string) map[string]any {
	t.Helper()
	resp, err := http.Get(url)
	require.NoError(t, err)
	defer resp.Body.Close()
	var out map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	return out
}

// The three routes are the Operator's: an agent's token is refused on them (the middleware reads operatorOnlyRoutes), so each must be listed there.
func TestRecordAgentRoutesAreOperatorOnly(t *testing.T) {
	for _, k := range []string{
		"GET /api/sessions/live/{sessionID}/agent-candidate",
		"POST /api/sessions/live/{sessionID}/record-agent",
		"POST /api/sessions/record-agents",
	} {
		assert.NotEmpty(t, operatorOnlyRoutes[k], "%s is in operatorOnlyRoutes", k)
	}
}

// Single record: the candidate is shown with its pid and program; recording what was shown works once; a program that changed since is refused and nothing is recorded.
func TestRecordASingleAgentOnlyWhileTheShownProgramIsStillTheOne(t *testing.T) {
	srv, term, _, nameA, _ := recordFixture(t)
	term.paused[nameA] = true
	term.cand[nameA] = ptymanager.AgentCandidate{PID: 4242, Start: "Wed Oct 29 13:46:00 2026", Program: "node"}

	out := getRecordJSON(t, srv+"/api/sessions/live/"+recordSIDa+"/agent-candidate")
	assert.Equal(t, true, out["paused"])
	cand, _ := out["candidate"].(map[string]any)
	require.NotNil(t, cand, "the program is shown with its pid and name")
	assert.EqualValues(t, 4242, cand["pid"])
	assert.Equal(t, "node", cand["program"])
	start, _ := cand["start"].(string)

	// The process changed between the confirm and the click: nothing is recorded.
	code, body := postRecordJSON(t, srv+"/api/sessions/live/"+recordSIDa+"/record-agent", map[string]any{"pid": 4243, "start": start})
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "changed", body["code"])
	code, _ = postRecordJSON(t, srv+"/api/sessions/live/"+recordSIDa+"/record-agent", map[string]any{"pid": 4242, "start": "Wed Oct 29 13:59:00 2026"})
	assert.Equal(t, http.StatusConflict, code, "a recycled pid (another start time) is not the process that was shown")
	assert.Empty(t, term.recorded, "nothing was recorded by the refused requests")

	// What was shown is recorded.
	code, body = postRecordJSON(t, srv+"/api/sessions/live/"+recordSIDa+"/record-agent", map[string]any{"pid": 4242, "start": start})
	assert.Equal(t, http.StatusOK, code)
	assert.EqualValues(t, 4242, body["pid"])
	assert.Equal(t, 4242, term.recorded[nameA].PID)
	assert.Equal(t, false, getRecordJSON(t, srv+"/api/sessions/live/"+recordSIDa+"/agent-candidate")["paused"], "notices go now: no button")

	// Bad requests and unknown sessions.
	code, _ = postRecordJSON(t, srv+"/api/sessions/live/"+recordSIDa+"/record-agent", map[string]any{"pid": 0, "start": ""})
	assert.Equal(t, http.StatusBadRequest, code)
	code, _ = postRecordJSON(t, srv+"/api/sessions/live/no-such-session/record-agent", map[string]any{"pid": 1, "start": "x"})
	assert.Equal(t, http.StatusNotFound, code)
}

// Not exactly one foreground program: there is no candidate, the reason is given, and a record is refused.
func TestNoCandidateWhenThereIsNotExactlyOneForegroundProgram(t *testing.T) {
	srv, term, _, nameA, _ := recordFixture(t)
	term.paused[nameA] = true
	term.why[nameA] = "several programs are in the foreground of the terminal"
	out := getRecordJSON(t, srv+"/api/sessions/live/"+recordSIDa+"/agent-candidate")
	assert.Nil(t, out["candidate"])
	assert.Equal(t, term.why[nameA], out["why_not"])
	code, body := postRecordJSON(t, srv+"/api/sessions/live/"+recordSIDa+"/record-agent", map[string]any{"pid": 1, "start": "x"})
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "changed", body["code"])
}

// Bulk: a paused agent whose single foreground program is its resolved CLI is recorded; anything ambiguous (a script run by node) is left paused and listed.
func TestBulkRecordRecordsTheAgentsWhoseProgramIsTheirCLIAndListsTheRest(t *testing.T) {
	srv, term, ss, nameA, nameB := recordFixture(t)
	cliA, err := ss.GetSettingsForCLI(context.Background())
	require.NoError(t, err)
	term.paused[nameA], term.paused[nameB] = true, true
	term.cand[nameA] = ptymanager.AgentCandidate{PID: 100, Start: "s1", Program: "claude", Image: cliA["cli_path_claude"]} // the resolved CLI itself
	term.cand[nameB] = ptymanager.AgentCandidate{PID: 200, Start: "s2", Program: "node", Image: "/usr/bin/node"}           // node running a script: ambiguous

	code, out := postRecordJSON(t, srv+"/api/sessions/record-agents", map[string]any{})
	require.Equal(t, http.StatusOK, code)
	recorded, _ := out["recorded"].([]any)
	left, _ := out["left"].([]any)
	require.Len(t, recorded, 1)
	assert.Equal(t, nameA, recorded[0].(map[string]any)["session"])
	require.Len(t, left, 1)
	assert.Equal(t, nameB, left[0].(map[string]any)["session"])
	assert.Contains(t, left[0].(map[string]any)["reason"], "ambiguous")
	assert.Equal(t, 100, term.recorded[nameA].PID)
	assert.NotContains(t, term.recorded, nameB, "the ambiguous one is not recorded")

	// An agent whose notices already go is not touched; a second run records nothing more.
	_, out = postRecordJSON(t, srv+"/api/sessions/record-agents", map[string]any{})
	assert.Empty(t, out["recorded"])
	assert.Len(t, out["left"], 1)
}

// A program that runs inside a nested shell is recorded only on the Operator's explicit acknowledgement; a direct child needs the plain confirm; bulk never records the nested one.
func TestRecordingAProgramUnderANestedShellNeedsTheAcknowledgement(t *testing.T) {
	srv, term, ss, nameA, nameB := recordFixture(t)
	settings, err := ss.GetSettingsForCLI(context.Background())
	require.NoError(t, err)
	term.paused[nameA], term.paused[nameB] = true, true
	// A is under a nested bash, and its image equals the resolved CLI (a hand-started copy of the real CLI); B is a direct child.
	term.cand[nameA] = ptymanager.AgentCandidate{PID: 100, Start: "s1", Program: "claude", Under: "bash", Image: settings["cli_path_claude"]}
	term.cand[nameB] = ptymanager.AgentCandidate{PID: 200, Start: "s2", Program: "codex", Image: settings["cli_path_codex"]}

	out := getRecordJSON(t, srv+"/api/sessions/live/"+recordSIDa+"/agent-candidate")
	cand, _ := out["candidate"].(map[string]any)
	require.NotNil(t, cand)
	assert.Equal(t, "bash", cand["under"], "the dashboard is told which shell the program runs inside")

	code, body := postRecordJSON(t, srv+"/api/sessions/live/"+recordSIDa+"/record-agent", map[string]any{"pid": 100, "start": "s1"})
	assert.Equal(t, http.StatusBadRequest, code, "without the acknowledgement")
	assert.Equal(t, "acknowledge_nested", body["code"])
	assert.Equal(t, "bash", body["under"])
	assert.NotContains(t, term.recorded, nameA, "nothing was recorded")

	// The bulk action never records it, even though its image is the CLI; the direct child is recorded.
	code, bulk := postRecordJSON(t, srv+"/api/sessions/record-agents", map[string]any{})
	require.Equal(t, http.StatusOK, code)
	recorded, _ := bulk["recorded"].([]any)
	left, _ := bulk["left"].([]any)
	require.Len(t, recorded, 1)
	assert.Equal(t, nameB, recorded[0].(map[string]any)["session"], "the direct child with the CLI's image")
	require.Len(t, left, 1)
	assert.Equal(t, nameA, left[0].(map[string]any)["session"])
	assert.Contains(t, left[0].(map[string]any)["reason"], "needs the button")
	assert.NotContains(t, term.recorded, nameA)

	// With the acknowledgement the Operator's request records it.
	code, _ = postRecordJSON(t, srv+"/api/sessions/live/"+recordSIDa+"/record-agent", map[string]any{"pid": 100, "start": "s1", "acknowledge_nested": true})
	assert.Equal(t, http.StatusOK, code)
	assert.Equal(t, 100, term.recorded[nameA].PID)
}

// #391, Unix: after an update, an npm-installed CLI runs as `node <script>`. Bulk records it only when the IMAGE is an interpreter and the script is exactly the resolved CLI file.
func TestBulkRecordsAnInterpreterRunningExactlyTheCLI(t *testing.T) {
	srv, term, ss, nameA, nameB := recordFixture(t)
	settings, err := ss.GetSettingsForCLI(context.Background())
	require.NoError(t, err)
	cli := settings["cli_path_claude"]
	require.NoError(t, os.WriteFile(cli, []byte("#!/usr/bin/env node\n"), 0o755))
	term.paused[nameA], term.paused[nameB] = true, true
	term.cand[nameA] = ptymanager.AgentCandidate{PID: 100, Start: "s1", Program: "node", Image: "/usr/bin/node", Script: cli}
	term.cand[nameB] = ptymanager.AgentCandidate{PID: 200, Start: "s2", Program: "node", Image: "/usr/bin/node", Script: cli + ".other"}

	code, out := postRecordJSON(t, srv+"/api/sessions/record-agents", map[string]any{})
	require.Equal(t, http.StatusOK, code)
	recorded, _ := out["recorded"].([]any)
	require.Len(t, recorded, 1)
	assert.Equal(t, nameA, recorded[0].(map[string]any)["session"])
	assert.NotContains(t, term.recorded, nameB, "another script")

	// A non-interpreter image never matches, whatever its (rewritable) command line said; a nested shell's program is never bulk-recorded.
	term.cand[nameB] = ptymanager.AgentCandidate{PID: 300, Start: "s3", Program: "bash", Image: "/bin/bash", Script: cli}
	_, out = postRecordJSON(t, srv+"/api/sessions/record-agents", map[string]any{})
	assert.Empty(t, out["recorded"])
	term.cand[nameB] = ptymanager.AgentCandidate{PID: 400, Start: "s4", Program: "node", Image: "/usr/bin/node", Script: cli, Under: "bash"}
	_, out = postRecordJSON(t, srv+"/api/sessions/record-agents", map[string]any{})
	assert.Empty(t, out["recorded"])
	assert.NotContains(t, term.recorded, nameB)
}

// The acknowledgement is checked in the record itself, not in an earlier read (Security on #391).
func TestTheAcknowledgementIsCheckedAtomicallyInTheRecord(t *testing.T) {
	srv, term, _, nameA, nameB := recordFixture(t)
	term.paused[nameA], term.paused[nameB] = true, true
	term.cand[nameA] = ptymanager.AgentCandidate{PID: 100, Start: "s1", Program: "claude", Image: "/x/claude"}
	term.readErr = map[string]error{}

	// The Operator is shown a direct child; before the record the same process moves under a nested shell: refused without the tick, nothing recorded.
	shown := getRecordJSON(t, srv+"/api/sessions/live/"+recordSIDa+"/agent-candidate")
	cand, _ := shown["candidate"].(map[string]any)
	require.Equal(t, "", cand["under"])
	term.cand[nameA] = ptymanager.AgentCandidate{PID: 100, Start: "s1", Program: "claude", Under: "bash", Image: "/x/claude"}
	code, out := postRecordJSON(t, srv+"/api/sessions/live/"+recordSIDa+"/record-agent", map[string]any{"pid": 100, "start": "s1"})
	assert.Equal(t, http.StatusBadRequest, code)
	assert.Equal(t, "acknowledge_nested", out["code"])
	assert.Equal(t, "bash", out["under"])
	assert.NotContains(t, term.recorded, nameA)

	// A failing read answers an error and records nothing, with or without the tick.
	term.readErr[nameA] = errors.New("the process table could not be read")
	for _, ack := range []bool{false, true} {
		code, _ = postRecordJSON(t, srv+"/api/sessions/live/"+recordSIDa+"/record-agent", map[string]any{"pid": 100, "start": "s1", "acknowledge_nested": ack})
		assert.Equal(t, http.StatusInternalServerError, code)
		assert.NotContains(t, term.recorded, nameA)
	}
	delete(term.readErr, nameA)

	// With the tick it records; bulk, which never ticks, leaves a program that moved under a nested shell.
	code, _ = postRecordJSON(t, srv+"/api/sessions/live/"+recordSIDa+"/record-agent", map[string]any{"pid": 100, "start": "s1", "acknowledge_nested": true})
	assert.Equal(t, http.StatusOK, code)
	assert.Contains(t, term.recorded, nameA)
}
