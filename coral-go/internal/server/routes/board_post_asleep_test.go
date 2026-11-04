package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #13189: only an agent put to sleep for being idle wakes on a delivery. A message to one that is asleep (by the Operator or because Coral stopped), whose terminal is gone, whose CLI exited or that is archived
// waits, and the sender is told which, in the post's answer.
func TestAPostToAnAgentThatWillNotReadItNowTellsTheSender(t *testing.T) {
	r := newOrchRig(t)
	ctx := context.Background()
	seat := func(member string, sleeping bool, n int) {
		r.seat(member, "Developer", orchBoard, "claude", sleeping, n)
	}
	r.seat("Orchestrator", "Orchestrator", orchBoard, "claude", false, 1)
	seat("Awake", false, 2)
	seat("Napping", true, 3)
	seat("Gone", true, 4)
	seat("Idle", true, 5)
	seat("Exited", true, 6)
	seat("Shelved", true, 7)
	require.NoError(t, r.ss.SetSessionSleepingFor(ctx, r.sid["Gone"], store.SleepReasonTerminalGone))
	require.NoError(t, r.ss.SetSessionSleepingFor(ctx, r.sid["Idle"], store.SleepReasonIdle))
	require.NoError(t, r.ss.SetSessionSleepingFor(ctx, r.sid["Exited"], store.SleepReasonAgentExited))
	_, err := r.ss.DB().ExecContext(ctx, `UPDATE live_sessions SET is_archived = 1 WHERE session_id = ?`, r.sid["Shelved"])
	require.NoError(t, err)

	lookup := MemberRestLookup(r.h.bs, r.ss)
	for member, want := range map[string]string{"Awake": "", "Napping": restAsleep, "Gone": restTerminalGone, "Idle": "", "Exited": restEnded, "Shelved": restArchived, "Nobody": ""} {
		assert.Equal(t, want, lookup(ctx, orchBoard, member), member)
	}

	h := &BoardHandler{bs: r.h.bs, memberRest: lookup}
	notes := h.postRestNotes(ctx, orchBoard, "Awake", []string{"Napping", "Gone", "Idle", "Exited", "Shelved", "Awake", "all", "Operator", "Nobody"})
	got := map[string]string{}
	for _, n := range notes {
		got[n["name"].(string)] = n["note"].(string)
	}
	assert.Equal(t, map[string]string{
		"Napping": "Napping is asleep; the message waits until it wakes.",
		"Gone":    "Gone's terminal is gone; the message waits until it is restarted.",
		"Exited":  "Exited has ended (its CLI exited); the message waits until it is restarted.",
		"Shelved": "Shelved is archived; the message waits until it is unarchived and woken.",
	}, got, "the idle sleeper wakes on delivery, and the poster, all and the Operator are not told about")

	// an Orchestrator with the Operator's wake grant is told it may wake the sleeper
	code, out := r.operatorGrant("Orchestrator", nil)
	require.Equal(t, http.StatusOK, code, "%v", out)
	notes = h.postRestNotes(ctx, orchBoard, "Orchestrator", []string{"Napping", "Gone"})
	require.Len(t, notes, 2)
	assert.Contains(t, notes[0]["note"], "you may wake it", "the grant is on")
	assert.NotContains(t, notes[1]["note"], "wake it", "a terminal-gone agent is restarted, not woken by this")
	noGrant := h.postRestNotes(ctx, orchBoard, "Awake", []string{"Napping"})
	assert.NotContains(t, noGrant[0]["note"], "you may wake it", "a worker holds no grant")
	assert.Nil(t, (&BoardHandler{bs: r.h.bs}).postRestNotes(ctx, orchBoard, "Awake", []string{"Napping"}), "no lookup: no notes")
}

// The handler puts the notes in its answer (the CLI and the dashboard read them from there).
func TestThePostAnswerCarriesTheAsleepNotes(t *testing.T) {
	server, h := setupBoardTestServer(t)
	h.SetMemberRestLookup(func(_ context.Context, _, member string) string {
		if member == "Dev" {
			return restAsleep
		}
		return ""
	})
	base := server.URL + "/api/board/rest-team"
	postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Lead", "job_title": "Orchestrator"}).Body.Close()
	postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Dev", "job_title": "Developer"}).Body.Close()
	resp := postJSON(t, base+"/messages", map[string]string{"subscriber_id": "Lead", "content": "@Dev please look"})
	defer resp.Body.Close()
	var out map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	require.Equal(t, http.StatusOK, resp.StatusCode, "%v", out)
	asleep, _ := out["asleep"].([]any)
	require.Len(t, asleep, 1, "%v", out)
	assert.Equal(t, "Dev", asleep[0].(map[string]any)["name"])
	assert.Equal(t, "Dev is asleep; the message waits until it wakes.", asleep[0].(map[string]any)["note"])
}

// QA Reviewer 2's SHOULDs on #13189: the poster and the Operator are not told about themselves, and "all" is not looked up as if it were a member (a lookup that records what it is asked).
func TestAPostNeverAsksAboutThePosterTheOperatorOrAll(t *testing.T) {
	var asked []string
	_, h := setupBoardTestServer(t)
	h.SetMemberRestLookup(func(_ context.Context, _, member string) string {
		asked = append(asked, member)
		return restAsleep
	})
	notes := h.postRestNotes(context.Background(), "team", "Poster", []string{"poster", "Poster", "Operator", "operator", "all", "ALL", "Dev"})
	assert.Equal(t, []string{"Dev"}, asked, "only a real other member is looked up")
	require.Len(t, notes, 1)
	assert.Equal(t, "Dev", notes[0]["name"])
}

// Security's INFO a on #13224 (#13285): the suggested command is shell-quoted, not Go-quoted: a member name may hold $, a backtick, a double or a single quote inside it, and a copy of the sentence must run nothing. The text is
// pinned for the plain name too.
func TestTheSuggestedWakeCommandIsQuotedForAShell(t *testing.T) {
	assert.Equal(t, "'Dev A'", shellQuote("Dev A"))
	assert.Equal(t, "'a$(touch x)b'", shellQuote("a$(touch x)b"), "no expansion inside single quotes")
	assert.Equal(t, "'x`id`y'", shellQuote("x`id`y"))
	assert.Equal(t, `'say "hi"'`, shellQuote(`say "hi"`))
	assert.Equal(t, `'it'\''s'`, shellQuote("it's"), "a single quote is closed, escaped and reopened")
	assert.Equal(t, "'Dev/Ops'", shellQuote("Dev/Ops"))
	assert.Equal(t, "Dev A is asleep; the message waits until it wakes. The Operator's wake grant is on, so you may wake it: coral-board wake 'Dev A'.",
		restSentence("Dev A", restAsleep, true), "the notice's own text is pinned")
	assert.Equal(t, "Dev A is asleep; the message waits until it wakes.", restSentence("Dev A", restAsleep, false), "no hint for a worker")
}
