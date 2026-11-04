package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/background"
	"github.com/subgentic/coral/internal/cliauth"
	"github.com/subgentic/coral/internal/store"
	"net/http"
	"testing"
	"time"
)

func TestChiefChecksOwnerSurfaceExistsWithoutConnectorCredentials(t *testing.T) {
	_, ts, dir := strictServer(t, true)
	token, err := cliauth.ReadToken(dir)
	require.NoError(t, err)
	cli := cliauth.CLIClient{Base: ts.URL, Token: token}
	resp, err := cli.Do(context.Background(), "GET", "/api/chief/checks", nil, nil, 0)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, 200, resp.StatusCode)
	var out map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	require.Empty(t, out["checks"])
}

const checksSID = "11111111-2222-4333-8444-555555555555"
const checksOther = "99999999-2222-4333-8444-555555555555"

type checksEnv struct {
	srv   *Server
	url   string
	cli   cliauth.CLIClient
	sched *store.ScheduleStore
	token string
}

func newChecksEnv(t *testing.T) *checksEnv {
	t.Helper()
	srv, ts, dir := strictServer(t, true)
	token, err := cliauth.ReadToken(dir)
	require.NoError(t, err)
	ss := store.NewSessionStore(srv.db)
	b := "chief"
	for i, id := range []string{checksSID, checksOther} {
		name := []string{"Chief", "Watcher"}[i]
		require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: id, AgentName: "claude-" + id, AgentType: "claude", BoardName: &b, WorkingDir: t.TempDir()}))
		_, err = srv.BoardStore().Subscribe(context.Background(), b, name, name, "claude-"+id, nil, "mentions")
		require.NoError(t, err)
	}
	tok, err := srv.db.MintSessionToken(context.Background(), checksSID, "claude-"+checksSID)
	require.NoError(t, err)
	return &checksEnv{srv: srv, url: ts.URL, cli: cliauth.CLIClient{Base: ts.URL, Token: token}, sched: store.NewScheduleStore(srv.db), token: tok}
}
func (e *checksEnv) call(t *testing.T, method, path string, body any, agent bool, key string) (int, map[string]any) {
	t.Helper()
	data, _ := json.Marshal(body)
	var resp *http.Response
	var err error
	if agent {
		req, _ := http.NewRequest(method, e.url+path, bytes.NewReader(data))
		req.Header.Set(store.SessionTokenHeader, e.token)
		req.Header.Set("Content-Type", "application/json")
		if key != "" {
			req.Header.Set("Idempotency-Key", key)
		}
		resp, err = http.DefaultClient.Do(req)
	} else {
		headers := http.Header{"Content-Type": []string{"application/json"}}
		if key != "" {
			headers.Set("Idempotency-Key", key)
		}
		resp, err = e.cli.Do(context.Background(), method, path, data, headers, 0)
	}
	require.NoError(t, err)
	defer resp.Body.Close()
	out := map[string]any{}
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}
func checksBody() map[string]any {
	return map[string]any{"name": "Mail", "instruction": "Check for the signed contract. @all @Watcher are quoted names, not extra recipients.", "target_board": "chief", "target_session": checksSID, "notify_mode": "only_if_found", "schedule_kind": "interval", "every_minutes": 5, "timezone": "UTC", "enabled": true}
}
func TestChiefChecksCreationSecretRefusalAndIdentity(t *testing.T) {
	e := newChecksEnv(t)
	body := checksBody()
	code, out := e.call(t, "POST", "/api/chief/checks", body, false, "")
	require.Equal(t, 201, code, out)
	require.Equal(t, false, out["wake_if_asleep"])
	code, out = e.call(t, "GET", "/api/chief/checks", nil, true, "")
	require.Equal(t, 403, code, out)
	code, out = e.call(t, "POST", "/api/chief/checks", body, true, "")
	require.Equal(t, 403, code, out)
	// Credential-keyword refusal is mandatory even when Hub keyword redaction is opted out.
	t.Setenv("CORAL_REDACT_KEYWORDS", "off")
	bad := checksBody()
	bad["instruction"] = "Use password=yellow-test-value"
	code, out = e.call(t, "POST", "/api/chief/checks", bad, false, "")
	require.Equal(t, 400, code, out)
	require.Equal(t, "secret_not_saved", out["code"])
	for _, patch := range []map[string]any{{"timezone": "No/SuchZone"}, {"every_minutes": 7}, {"target_board": "another-team"}, {"credential": "not accepted"}} {
		b := checksBody()
		for k, v := range patch {
			b[k] = v
		}
		code, out = e.call(t, "POST", "/api/chief/checks", b, false, "")
		require.Equal(t, 400, code, out)
	}
	rows, err := e.sched.ChiefChecks(context.Background())
	require.NoError(t, err)
	require.Len(t, rows, 1)
	code, out = e.call(t, "GET", "/api/scheduled/jobs", nil, false, "")
	require.Equal(t, 200, code, out)
	raw, _ := json.Marshal(out)
	require.NotContains(t, string(raw), "Mail")
	require.NotContains(t, string(raw), "instruction")
	for _, method := range []string{"GET", "PUT", "DELETE"} {
		code, out = e.call(t, method, fmt.Sprintf("/api/scheduled/jobs/%d", rows[0].JobID), map[string]any{"prompt": "bypass"}, false, "")
		require.Equal(t, 404, code, out)
	}
}
func TestChiefChecksDeliveryUsesOneRecipientAndResolutionIsSessionBound(t *testing.T) {
	e := newChecksEnv(t)
	ctx := context.Background()
	sched := background.NewJobScheduler(e.sched, time.Minute)
	e.srv.SetScheduler(sched)
	code, out := e.call(t, "POST", "/api/chief/checks", checksBody(), false, "")
	require.Equal(t, 201, code, out)
	id := int64(out["id"].(float64))
	code, out = e.call(t, "POST", fmt.Sprintf("/api/chief/checks/%d/run", id), nil, false, "manual-run-one")
	require.Equal(t, 202, code, out)
	var tr store.ChiefTrigger
	require.Eventually(t, func() bool {
		rows, _ := e.sched.ChiefTriggers(ctx, id, 0, "")
		if len(rows) > 0 {
			tr = rows[0]
		}
		return tr.Delivery == "delivered"
	}, 3*time.Second, 10*time.Millisecond)
	msgs, err := e.srv.BoardStore().ListMessages(ctx, "chief", 100, 0, 0)
	require.NoError(t, err)
	require.Len(t, msgs, 1)
	require.Equal(t, "Coral Task Queue", msgs[0].SubscriberID)
	require.True(t, msgs[0].IsSystem)
	require.Contains(t, msgs[0].Content, "@Chief ")
	require.NotContains(t, msgs[0].Content, "@all")
	require.NotContains(t, msgs[0].Content, "@Watcher")
	code, out = e.call(t, "POST", fmt.Sprintf("/api/chief/checks/%d/run", id), nil, false, "manual-run-one")
	require.Equal(t, 202, code, out)
	msgs, err = e.srv.BoardStore().ListMessages(ctx, "chief", 100, 0, 0)
	require.NoError(t, err)
	require.Len(t, msgs, 1, "same request cannot duplicate a message")
	path := fmt.Sprintf("/api/chief/triggers/%d/state", tr.ID)
	other, err := e.srv.db.MintSessionToken(ctx, checksOther, "claude-"+checksOther)
	require.NoError(t, err)
	original := e.token
	e.token = other
	code, out = e.call(t, "POST", path, map[string]any{"state": "done", "session_id": checksSID}, true, "")
	require.Equal(t, 403, code, out)
	e.token = original
	code, out = e.call(t, "POST", path, map[string]any{"state": "routed", "task_id": 999999}, true, "")
	require.Equal(t, 400, code, out)
	code, out = e.call(t, "POST", path, map[string]any{"state": "waiting_on_operator", "ask_id": 999999}, true, "")
	require.Equal(t, 400, code, out)
	code, out = e.call(t, "POST", path, map[string]any{"state": "done", "summary": "Nothing new; password=example-value"}, true, "")
	require.Equal(t, 200, code, out)
	require.NotContains(t, out["summary"], "example-value")
	code, out = e.call(t, "POST", path, map[string]any{"state": "done", "summary": "Nothing new"}, true, "")
	require.Equal(t, 200, code, out)
}

func TestChiefTriggerAskReferencesUseVerifiedSessionNotReusableRole(t *testing.T) {
	e := newChecksEnv(t)
	ctx := context.Background()
	code, out := e.call(t, "POST", "/api/chief/checks", checksBody(), false, "")
	require.Equal(t, 201, code, out)
	id := int64(out["id"].(float64))
	tr, err := e.sched.BeginChiefTrigger(ctx, id, 0, "own-ask-trigger", time.Now())
	require.NoError(t, err)
	_, err = e.srv.BoardStore().Subscribe(ctx, "chief", "Operator", "Operator", "", nil, "all")
	require.NoError(t, err)
	code, ask := e.call(t, "POST", "/api/board/chief/messages", map[string]any{"subscriber_id": "Chief", "content": "@Operator Please decide this check result", "ask": true}, true, "")
	require.Equal(t, 200, code, ask)
	askID := int64(ask["id"].(float64))
	author, err := e.srv.BoardStore().MessageSession(ctx, "chief", askID)
	require.NoError(t, err)
	require.Equal(t, checksSID, author)
	path := fmt.Sprintf("/api/chief/triggers/%d/state", tr.ID)
	code, out = e.call(t, "POST", path, map[string]any{"state": "waiting_on_operator", "ask_id": askID}, true, "")
	require.Equal(t, 200, code, out)
	// An ask on another board must not be accepted even with a valid message id.
	_, err = e.srv.BoardStore().Subscribe(ctx, "other", "Other", "Other", "claude-"+checksOther, nil, "mentions")
	require.NoError(t, err)
	otherTask, err := e.srv.BoardStore().CreateTask(ctx, "other", "Other team's task", "", "medium", "Operator")
	require.NoError(t, err)
	code, out = e.call(t, "POST", path, map[string]any{"state": "routed", "task_id": otherTask.ID}, true, "")
	require.Equal(t, 400, code, out)
	// Replacing Chief's role with a different session does not transfer ask authorship.
	_, err = e.srv.BoardStore().Unsubscribe(ctx, "chief", "Watcher")
	require.NoError(t, err)
	_, err = e.srv.BoardStore().Subscribe(ctx, "chief", "Chief", "Chief", "claude-"+checksOther, nil, "mentions")
	require.NoError(t, err)
	code, out = e.call(t, "POST", path, map[string]any{"state": "done"}, true, "")
	require.Equal(t, 403, code, out, "departed session cannot resolve")
	body := checksBody()
	body["target_session"] = checksOther
	body["name"] = "Replacement"
	code, out = e.call(t, "POST", "/api/chief/checks", body, false, "")
	require.Equal(t, 201, code, out)
	newer, err := e.sched.BeginChiefTrigger(ctx, int64(out["id"].(float64)), 0, "replacement-ask", time.Now())
	require.NoError(t, err)
	e.token, err = e.srv.db.MintSessionToken(ctx, checksOther, "claude-"+checksOther)
	require.NoError(t, err)
	code, out = e.call(t, "POST", fmt.Sprintf("/api/chief/triggers/%d/state", newer.ID), map[string]any{"state": "waiting_on_operator", "ask_id": askID}, true, "")
	require.Equal(t, 400, code, out)
}

func TestChiefDailyBriefRemainsUnconsumedUntilActualBriefReference(t *testing.T) {
	e := newChecksEnv(t)
	ctx := context.Background()
	body := checksBody()
	body["notify_mode"] = "daily_brief"
	code, out := e.call(t, "POST", "/api/chief/checks", body, false, "")
	require.Equal(t, 201, code, out)
	tr, err := e.sched.BeginChiefTrigger(ctx, int64(out["id"].(float64)), 0, "daily-brief-test", time.Now())
	require.NoError(t, err)
	path := fmt.Sprintf("/api/chief/triggers/%d/state", tr.ID)
	code, out = e.call(t, "POST", path, map[string]any{"state": "done", "summary": "Saved for the brief"}, true, "")
	require.Equal(t, 400, code, out)
	saved, err := e.sched.ChiefTrigger(ctx, tr.ID)
	require.NoError(t, err)
	require.Equal(t, "open", saved.State)
	code, msg := e.call(t, "POST", "/api/board/chief/messages", map[string]any{"subscriber_id": "Chief", "content": "Daily brief: no new mail"}, true, "")
	require.Equal(t, 200, code, msg)
	code, out = e.call(t, "POST", path, map[string]any{"state": "done", "brief_id": msg["id"]}, true, "")
	require.Equal(t, 200, code, out)
}

func TestChiefPrivateDeliveryRunsStayOutOfGenericTaskRoutes(t *testing.T) {
	e := newChecksEnv(t)
	ctx := context.Background()
	code, out := e.call(t, "POST", "/api/chief/checks", checksBody(), false, "")
	require.Equal(t, 201, code, out)
	c, err := e.sched.ChiefCheck(ctx, int64(out["id"].(float64)))
	require.NoError(t, err)
	id, err := e.sched.CreateScheduledRun(ctx, c.JobID, time.Now().UTC().Format(store.ISOFormat), "pending")
	require.NoError(t, err)
	code, out = e.call(t, "GET", fmt.Sprintf("/api/tasks/runs/%d", id), nil, true, "")
	require.Equal(t, 404, code, out)
	code, out = e.call(t, "GET", "/api/tasks/active", nil, false, "")
	require.Equal(t, 200, code, out)
	require.Empty(t, out["runs"])
	code, out = e.call(t, "POST", fmt.Sprintf("/api/tasks/runs/%d/kill", id), nil, false, "")
	require.Equal(t, 404, code, out)
	run, err := e.sched.GetScheduledRun(ctx, id)
	require.NoError(t, err)
	require.Equal(t, "pending", run.Status)
}

// The person clicks from an older list snapshot after the agent has reported.
func TestChiefPersonResolutionPreservesInterveningAgentReport(t *testing.T) {
	e := newChecksEnv(t)
	ctx := context.Background()
	code, check := e.call(t, "POST", "/api/chief/checks", checksBody(), false, "")
	require.Equal(t, 201, code, check)
	tr, err := e.sched.BeginChiefTrigger(ctx, int64(check["id"].(float64)), 0, "person-preserve", time.Now())
	require.NoError(t, err)
	path := fmt.Sprintf("/api/chief/triggers/%d/state", tr.ID)
	task, err := e.srv.BoardStore().CreateTask(ctx, "chief", "Check result task", "", "medium", "Operator")
	require.NoError(t, err)
	_, err = e.srv.BoardStore().Subscribe(ctx, "chief", "Operator", "Operator", "", nil, "all")
	require.NoError(t, err)
	code, ask := e.call(t, "POST", "/api/board/chief/messages", map[string]any{"subscriber_id": "Chief", "content": "@Operator Decide the latest check", "ask": true}, true, "")
	require.Equal(t, 200, code, ask)
	code, brief := e.call(t, "POST", "/api/board/chief/messages", map[string]any{"subscriber_id": "Chief", "content": "Latest check brief"}, true, "")
	require.Equal(t, 200, code, brief)
	for _, report := range []map[string]any{
		{"state": "routed", "summary": "Latest task report", "task_id": task.ID, "brief_id": brief["id"]},
		{"state": "waiting_on_operator", "summary": "Latest question report", "ask_id": ask["id"], "brief_id": brief["id"]},
	} {
		code, listed := e.call(t, "GET", "/api/chief/triggers", nil, false, "")
		require.Equal(t, 200, code, listed)
		code, updated := e.call(t, "POST", path, report, true, "")
		require.Equal(t, 200, code, updated)
		for _, state := range []string{"done", "open"} {
			code, out := e.call(t, "POST", path, map[string]any{"state": state}, false, "")
			require.Equal(t, 200, code, out)
			require.Equal(t, state, out["state"])
			saved, err := e.sched.ChiefTrigger(ctx, tr.ID)
			require.NoError(t, err)
			for _, field := range []string{"summary", "task_id", "ask_id", "brief_id"} {
				require.Equal(t, updated[field], out[field], "%s response preserves %s", state, field)
			}
			require.Equal(t, report["summary"], saved.Summary)
			require.EqualValues(t, brief["id"], saved.BriefID)
			if report["state"] == "routed" {
				require.Equal(t, task.ID, saved.TaskID)
			} else {
				require.EqualValues(t, ask["id"], saved.AskID)
			}
		}
	}
	code, out := e.call(t, "POST", path, map[string]any{"state": "done", "summary": "stale cached summary", "brief_id": 999999}, false, "")
	require.Equal(t, 200, code, out)
	require.Equal(t, "Latest question report", out["summary"])
	require.Equal(t, brief["id"], out["brief_id"])
}
