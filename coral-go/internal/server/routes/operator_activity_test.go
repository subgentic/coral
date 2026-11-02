package routes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jmoiron/sqlx"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #12069: the Activity record through the real handlers: a decision writes its row (the version decided, the actor and source from the request), a rolled-back one says so, and the read is the Operator's alone.

func (e *reviewEnv) activityServer(t *testing.T, person bool) *httptest.Server {
	t.Helper()
	r := chi.NewRouter()
	r.Get("/api/activity", func(w http.ResponseWriter, req *http.Request) {
		if person {
			req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		}
		e.h.ListActivity(w, req)
	})
	s := httptest.NewServer(r)
	t.Cleanup(s.Close)
	return s
}

func getActivity(t *testing.T, base, query string, hdr map[string]string) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest("GET", base+"/api/activity"+query, nil)
	require.NoError(t, err)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestAnApprovalAndADenialAreInTheRecordWithTheVersionDecidedAndTheActorFromTheRequest(t *testing.T) {
	e := newReviewEnv(t, true)
	act := e.activityServer(t, true)
	e.tag(t, `["for review"]`)
	code, out := e.call(t, http.MethodPost, "/api/board/alpha/artifacts/"+e.id+"/review", `{"decision":"deny","reason":"`+strings.Repeat("no ", 100)+`"}`)
	require.Equal(t, http.StatusOK, code, out)
	code, out = getActivity(t, act.URL, "", nil)
	require.Equal(t, http.StatusOK, code, out)
	rows := out["actions"].([]any)
	require.Len(t, rows, 1)
	row := rows[0].(map[string]any)
	assert.Equal(t, "deny", row["action"])
	assert.Equal(t, e.id, row["version"], "the digest of the exact version decided")
	assert.Equal(t, e.id, row["item_id"])
	assert.Equal(t, "alpha", row["team"])
	assert.Equal(t, "local", row["source"])
	assert.Equal(t, "local", row["actor"])
	assert.Equal(t, "plan.md", row["title"])
	assert.LessOrEqual(t, len([]rune(row["note"].(string))), 200, "the reason is cut")
	assert.Equal(t, true, out["check"].(map[string]any)["intact"])
	assert.NotContains(t, row, "prev_hash")
	assert.NotContains(t, row, "hash")
}

func TestAFailedPostLeavesTheApprovalAndAnUndoneRowInTheRecord(t *testing.T) {
	e := newReviewEnv(t, true)
	act := e.activityServer(t, true)
	e.tag(t, `["for review"]`)
	e.h.reviewPost = func(context.Context, string, string) error { return errors.New("the board is gone") }
	code, _ := e.approve(t)
	require.Equal(t, http.StatusInternalServerError, code)
	_, out := getActivity(t, act.URL, "", nil)
	rows := out["actions"].([]any)
	require.Len(t, rows, 2)
	assert.Equal(t, "undone", rows[0].(map[string]any)["action"])
	assert.Equal(t, "approve", rows[1].(map[string]any)["action"])
}

func TestTheHintIsPhoneOrNothingAndIgnoreAndSaveAreRecorded(t *testing.T) {
	e := newReviewEnv(t, true)
	act := e.activityServer(t, true)
	e.tag(t, `["for review"]`)
	for _, tc := range []struct{ decision, hint, want string }{{"save", "phone", "phone"}, {"unsave", "<b>x</b>", ""}, {"ignore", "", ""}} {
		req, _ := http.NewRequest("POST", e.srv.URL+"/api/board/alpha/artifacts/"+e.id+"/review", strings.NewReader(`{"decision":"`+tc.decision+`"}`))
		req.Header.Set("Content-Type", "application/json")
		if tc.hint != "" {
			req.Header.Set("X-Coral-Client", tc.hint)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode, tc.decision)
		_, out := getActivity(t, act.URL, "?action="+tc.decision, nil)
		rows := out["actions"].([]any)
		require.Len(t, rows, 1, tc.decision)
		h, _ := rows[0].(map[string]any)["hint"].(string)
		assert.Equal(t, tc.want, h, tc.decision)
	}
	_, out := getActivity(t, act.URL, "?team=alpha&limit=2", nil)
	assert.Len(t, out["actions"].([]any), 2)
	_, out = getActivity(t, act.URL, "?team=nowhere", nil)
	assert.Empty(t, out["actions"])
}

func TestTheRecordIsTheOperatorsAloneAndThroughTheHubTheOwnersAlone(t *testing.T) {
	withLabel(t, "hub-user-1234abcd", nil) // the machine is enrolled as that account's: its owner stamp passes the owner check
	e := newReviewEnv(t, true)
	e.tag(t, `["for review"]`)
	e.approve(t)
	notPerson := e.activityServer(t, false) // an agent token, a script: not a person
	code, _ := getActivity(t, notPerson.URL, "", nil)
	assert.Equal(t, http.StatusForbidden, code)
	act := e.activityServer(t, true)
	// through the Hub the owner reads it (read only: the route is a GET and nothing else is routed); nobody else does
	owner := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: "hub-user-1234abcd"}
	code, out := getActivity(t, act.URL, "", owner)
	require.Equal(t, http.StatusOK, code, out)
	assert.Len(t, out["actions"], 1)
	for name, hdr := range map[string]map[string]string{
		"a Hub viewer with no marker":    {tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubUserHeader: "someone"},
		"a Hub grantee":                  {tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "grantee", tunnel.HubUserHeader: "hub-user-9999ffff"},
		"another account's owner marker": {tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: "hub-user-9999ffff"},
		"a forged stamp":                 {tunnel.ViaHeader: "not-the-secret", tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: "hub-user-1234abcd"},
	} {
		code, _ := getActivity(t, act.URL, "", hdr)
		assert.Equal(t, http.StatusForbidden, code, name)
	}
	for _, bad := range []string{"?action=bogus", "?before=-1", "?before=x", "?limit=0", "?team=../x", "?before_at=2026-11-02T10:00:00Z", "?before=5&before_at=yesterday"} {
		code, _ := getActivity(t, act.URL, bad, nil)
		assert.Equal(t, http.StatusBadRequest, code, bad)
	}
}

// coral-hub merges one owner's records from several computers (#12070): a row's id is unique per record and the answer names the record, times are UTC with milliseconds and paging is by (time, id), the limit's
// maximum and whether more exist are in the answer, and the check is the machine's own.
func TestTheAnswerIsMadeForAHubThatMergesSeveralComputers(t *testing.T) {
	e := newReviewEnv(t, true)
	act := e.activityServer(t, true)
	meta := board.ActivityMeta{Actor: "local", Source: "local"}
	for i := 0; i < 5; i++ {
		require.NoError(t, e.h.bs.RecordActivity(context.Background(), meta, board.ActSave, "file", fmt.Sprintf("item-%d", i), "", "alpha"))
	}
	code, out := getActivity(t, act.URL, "?limit=2", nil)
	require.Equal(t, http.StatusOK, code, out)
	rows := out["actions"].([]any)
	require.Len(t, rows, 2)
	assert.Equal(t, true, out["more"], "more exist past this page")
	assert.Equal(t, float64(board.ActivityMaxLimit), out["limit_max"])
	rid, _ := out["record_id"].(string)
	assert.Len(t, rid, 32, "the record's own random id")
	first := rows[0].(map[string]any)
	assert.Regexp(t, `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`, first["at"], "UTC with milliseconds")
	assert.Equal(t, "item-4", first["item_id"], "newest first")
	assert.NotNil(t, out["check"], "the first page carries the machine's check")
	// the next page by (time, id)
	next := fmt.Sprintf("?limit=2&before=%d&before_at=%s", int64(out["next_before"].(float64)), out["next_before_at"])
	code, out2 := getActivity(t, act.URL, next, nil)
	require.Equal(t, http.StatusOK, code, out2)
	rows2 := out2["actions"].([]any)
	require.Len(t, rows2, 2)
	assert.Equal(t, "item-2", rows2[0].(map[string]any)["item_id"])
	assert.Equal(t, rid, out2["record_id"], "the same record")
	assert.Nil(t, out2["check"], "not repeated on later pages")
	code, out3 := getActivity(t, act.URL, fmt.Sprintf("?limit=2&before=%d&before_at=%s", int64(out2["next_before"].(float64)), out2["next_before_at"]), nil)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, false, out3["more"], "the last page says so")
	assert.Len(t, out3["actions"], 1)
	// a limit past the maximum is cut to it, and no row carries a hash
	_, big := getActivity(t, act.URL, "?limit=100000", nil)
	assert.LessOrEqual(t, len(big["actions"].([]any)), board.ActivityMaxLimit)
	raw, _ := json.Marshal(big)
	assert.NotContains(t, string(raw), "prev_hash")
	assert.NotContains(t, string(raw), `"hash"`)
}

// docs/activity-api.md gives coral-hub the exact function of a personal computer's Hub actor label with these vectors; a change to either side fails here (#12070): "hub:" and the first 12 lower-case hex digits
// of the SHA-256 of the stamped label's bytes as sent, with no trimming, case folding or normalization.
func TestAPersonalComputersHubActorLabelMatchesTheVectorsInTheAPINote(t *testing.T) {
	vectors := map[string]string{
		"hub-user-1234abcd": "90328ec01809",
		"hub-user-9999ffff": "1802bdf6841b",
		"hub-user-0000aaaa": "0c74ded601b3",
		"Hub-User-1234ABCD": "e7c28f167ef5", // not folded: the label is taken as it was sent
	}
	note, err := os.ReadFile("../../../docs/activity-api.md")
	require.NoError(t, err)
	for label, want := range vectors {
		assert.Equal(t, "hub:"+want, activityActor(callerIdentity{owner: true, pseudo: label}), label)
		assert.Contains(t, string(note), "`"+label+"`", "the note names the vector's label")
		assert.Contains(t, string(note), "`hub:"+want+"`", "the note names the vector's value for "+label)
	}
}

func TestTheActorLabelIsTheStableIdOrAHashNeverTheNameOrTheEmail(t *testing.T) {
	assert.Equal(t, "local", activityActor(callerIdentity{local: true, owner: true, pseudo: "local"}))
	id := "hub-uid-" + strings.Repeat("ab", 16)
	assert.Equal(t, "hub:"+id, activityActor(callerIdentity{owner: true, team: true, hubUserID: id, pseudo: "Rich"}), "the stable id is the label")
	got := activityActor(callerIdentity{owner: true, pseudo: "Rich Knorowski <rich@example.com>"})
	assert.True(t, strings.HasPrefix(got, "hub:"))
	assert.NotContains(t, got, "Rich")
	assert.NotContains(t, got, "@")
	assert.Equal(t, got, activityActor(callerIdentity{owner: true, pseudo: "Rich Knorowski <rich@example.com>"}), "the same account is the same label")
	assert.Equal(t, "hub:unknown", activityActor(callerIdentity{}), "a request that is not an authentic owner's names nobody")
	assert.Equal(t, "hub:unknown", activityActor(callerIdentity{pseudo: "Rich"}))
	// a request with a stamp that is not authentic is recorded as the Hub, by nobody
	forged := httptest.NewRequest("POST", "/", nil)
	forged.Header.Set(tunnel.ViaHeader, "not-the-secret")
	forged.Header.Set(tunnel.HubUserHeader, "Rich")
	m := activityMetaFor(forged, "", "")
	assert.Equal(t, "hub", m.Source)
	assert.Equal(t, "hub:unknown", m.Actor)
}

// The best-effort rows (#12069): a proposal's approve and reject, a goal the Operator closes, and nothing for an agent's own close.

func TestProposalsAreRecordedWithTheReasonAndARefusedActionLeavesNoRow(t *testing.T) {
	e := newProposalEnv(t)
	e.settings(t, board.BoardSettingsUpdate{GoalsNeedApproval: boolp(true)})
	_, a := e.call(t, "", "POST", "/api/board/team/goals", map[string]any{"title": "Ship the beta", "outcome": "People use it", "subscriber_id": "Orchestrator"})
	_, b := e.call(t, "", "POST", "/api/board/team/goals", map[string]any{"title": "Rewrite everything", "outcome": "Why not", "subscriber_id": "Orchestrator"})
	ida, idb := int64(a["proposal_id"].(float64)), int64(b["proposal_id"].(float64))
	code, out := e.call(t, "person", "POST", "/api/board/team/proposals/"+itoa(ida)+"/approve", nil)
	require.Equal(t, http.StatusOK, code, out)
	code, out = e.call(t, "person", "POST", "/api/board/team/proposals/"+itoa(idb)+"/reject", map[string]any{"reason": "Not this quarter"})
	require.Equal(t, http.StatusOK, code, out)
	rows, err := e.h.bs.ListActivity(context.Background(), board.ActivityFilter{})
	require.NoError(t, err)
	require.Len(t, rows, 2)
	assert.Equal(t, "deny", rows[0].Action)
	assert.Equal(t, "proposal", rows[0].ItemKind)
	assert.Equal(t, itoa(idb), rows[0].ItemID)
	assert.Equal(t, "Not this quarter", rows[0].Note)
	assert.Equal(t, "Rewrite everything", rows[0].Title)
	assert.Equal(t, "approve", rows[1].Action)
	assert.Equal(t, "Ship the beta", rows[1].Title)
	assert.Equal(t, "team", rows[1].Team)
	chk, err := e.h.bs.VerifyActivity(context.Background())
	require.NoError(t, err)
	assert.True(t, chk.Intact)

	// an agent that asks for the same thing again is refused and leaves nothing
	before, _ := e.h.bs.ListActivity(context.Background(), board.ActivityFilter{})
	code, _ = e.call(t, "person", "POST", "/api/board/team/proposals/"+itoa(ida)+"/approve", nil)
	assert.NotEqual(t, http.StatusOK, code, "approved already")
	after, _ := e.h.bs.ListActivity(context.Background(), board.ActivityFilter{})
	assert.Len(t, after, len(before), "a refused action leaves no row")
}

func TestAGoalTheOperatorClosesIsRecordedAndOneAnAgentClosesIsNot(t *testing.T) {
	e := newProposalEnv(t)
	r := chi.NewRouter()
	r.Post("/api/board/{project}/goals/{goalID}/close", func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("X-Test-Caller") == "person" {
			req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		}
		e.h.CloseGoal(w, req)
	})
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	post := func(caller, goal int64, body string) int {
		req, _ := http.NewRequest("POST", fmt.Sprintf("%s/api/board/team/goals/%d/close", srv.URL, goal), strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if caller != 0 {
			req.Header.Set("X-Test-Caller", "person")
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		return resp.StatusCode
	}
	g1, err := e.h.bs.CreateGoal(context.Background(), "team", board.GoalInput{Title: "Agent closes this", Outcome: "o", CreatedBy: "Orchestrator"})
	require.NoError(t, err)
	g2, err := e.h.bs.CreateGoal(context.Background(), "team", board.GoalInput{Title: "Operator closes this", Outcome: "o", CreatedBy: "Orchestrator"})
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, post(0, g1.ID, `{"reason":"shipped","subscriber_id":"Orchestrator"}`))
	rows, _ := e.h.bs.ListActivity(context.Background(), board.ActivityFilter{})
	assert.Empty(t, rows, "an agent closing a goal is not the Operator's action")
	require.Equal(t, http.StatusOK, post(1, g2.ID, `{"reason":"not needed any more","subscriber_id":"Operator"}`))
	rows, _ = e.h.bs.ListActivity(context.Background(), board.ActivityFilter{})
	require.Len(t, rows, 1)
	assert.Equal(t, "goal_close", rows[0].Action)
	assert.Equal(t, "goal", rows[0].ItemKind)
	assert.Equal(t, "Operator closes this", rows[0].Title)
	assert.Equal(t, "done: not needed any more", rows[0].Note)
}

// The operator's rule for coral-hub (#12070): users on a team see only what they were approved to view. On a team's machine the owners are the recorded organisation's owner and admin roles (the personal marker is
// not read there); a member who has been granted the computer, another organisation's people and a stamp that is not complete do not read the record.
func TestOnATeamsMachineAMemberGrantedTheComputerStillCannotReadTheRecord(t *testing.T) {
	withRecord(t, tunnel.OwnerKindTeam, teamOrgA, nil)
	withLabel(t, "", nil)
	e := newReviewEnv(t, true)
	act := e.activityServer(t, true)
	flat := func(h http.Header) map[string]string {
		m := map[string]string{}
		for k := range h {
			m[k] = h.Get(k)
		}
		return m
	}
	marked := func(h http.Header) http.Header { h.Set(tunnel.HubRoleHeader, tunnel.HubRoleOwner); return h }
	for name, tc := range map[string]struct {
		hdr  http.Header
		want int
	}{
		"an admin of the recorded organisation":                            {teamStamp(teamOrgA, "admin", teamUIDA, teamUser), http.StatusOK},
		"an owner role of the recorded organisation":                       {teamStamp(teamOrgA, "owner", teamUIDA, teamUser), http.StatusOK},
		"a member granted the computer":                                    {teamStamp(teamOrgA, "member", teamUIDA, teamUser), http.StatusForbidden},
		"a member, even with the personal owner marker":                    {marked(teamStamp(teamOrgA, "member", teamUIDA, teamUser)), http.StatusForbidden},
		"another organisation's admin, even with the owner marker":         {marked(teamStamp(teamOrgB, "admin", teamUIDB, teamUser)), http.StatusForbidden},
		"an admin whose stamp has no stable id (not complete)":             {teamStamp(teamOrgA, "admin", "", teamUser), http.StatusForbidden},
		"an admin with only the label, never keyed on it (no hub-uid- id)": {teamStamp(teamOrgA, "admin", "", teamUser), http.StatusForbidden},
		"an admin with a stable id and no label":                           {teamStamp(teamOrgA, "admin", teamUIDA, ""), http.StatusForbidden},
		"an admin with an id that is not a hub-uid- id":                    {teamStamp(teamOrgA, "admin", "hub-user-1234abcd", teamUser), http.StatusForbidden},
		"a forged connector stamp": {func() http.Header {
			h := teamStamp(teamOrgA, "admin", teamUIDA, teamUser)
			h.Set(tunnel.ViaHeader, "forged")
			return h
		}(), http.StatusForbidden},
	} {
		code, out := getActivity(t, act.URL, "", flat(tc.hdr))
		assert.Equal(t, tc.want, code, name)
		if tc.want == http.StatusForbidden {
			assert.NotContains(t, out, "actions", name+": nothing of the record is in a refusal")
		}
	}
}

// "Own rows only" (the Operator's choice, #12070): on a computer enrolled to a Coral Hub team each owner sees the rows where they are the actor and nobody else's, the count in the check is their own and a break is
// said without the id of a row that is not theirs; the person at the computer sees everything.
func TestOnATeamsMachineEachOwnerSeesOnlyTheirOwnRowsAndTheLocalPersonSeesAll(t *testing.T) {
	withRecord(t, tunnel.OwnerKindTeam, teamOrgA, nil)
	withLabel(t, "", nil)
	e := newReviewEnv(t, true)
	act := e.activityServer(t, true)
	ctx := context.Background()
	for _, r := range []struct{ actor, source, item string }{{"hub:" + teamUIDA, "hub", "a-1"}, {"hub:" + teamUIDB, "hub", "b-1"}, {"hub:" + teamUIDA, "hub", "a-2"}, {"local", "local", "local-1"}, {"hub:" + teamUIDB, "hub", "b-2"}} {
		require.NoError(t, e.h.bs.RecordActivity(ctx, board.ActivityMeta{Actor: r.actor, Source: r.source}, board.ActSave, "file", r.item, "", "alpha"))
	}
	owner := func(uid string) map[string]string {
		h := teamStamp(teamOrgA, "admin", uid, teamUser)
		m := map[string]string{}
		for k := range h {
			m[k] = h.Get(k)
		}
		return m
	}
	items := func(out map[string]any) []string {
		var ids []string
		for _, r := range out["actions"].([]any) {
			ids = append(ids, r.(map[string]any)["item_id"].(string))
		}
		return ids
	}
	code, a := getActivity(t, act.URL, "", owner(teamUIDA))
	require.Equal(t, http.StatusOK, code, a)
	assert.Equal(t, []string{"a-2", "a-1"}, items(a), "the first owner reads their own rows alone, newest first")
	assert.Equal(t, float64(2), a["check"].(map[string]any)["rows"], "and the check counts theirs")
	code, b := getActivity(t, act.URL, "", owner(teamUIDB))
	require.Equal(t, http.StatusOK, code, b)
	assert.Equal(t, []string{"b-2", "b-1"}, items(b), "the second reads theirs")
	raw, _ := json.Marshal([]any{a, b})
	assert.NotContains(t, string(raw), "local-1", "nobody on the Hub reads the person at the computer's row")
	// the person at the computer: no Hub in the request
	code, all := getActivity(t, act.URL, "", nil)
	require.Equal(t, http.StatusOK, code)
	assert.Len(t, items(all), 5, "the local person reads every row")
	assert.Equal(t, float64(5), all["check"].(map[string]any)["rows"])
	// a break is said, but not as the id of a row that is not theirs
	outside, err := sqlx.Open("sqlite", lastBoardTestDBPath) // another owner's row edited outside Coral, by another program
	require.NoError(t, err)
	defer outside.Close()
	_, err = outside.ExecContext(ctx, `UPDATE operator_actions SET action = 'deny' WHERE item_id = 'b-1'`)
	require.NoError(t, err)
	_, a2 := getActivity(t, act.URL, "", owner(teamUIDA))
	chk := a2["check"].(map[string]any)
	assert.Equal(t, false, chk["intact"], "the record is not intact")
	assert.NotContains(t, chk, "first_bad", "and the first bad row's id is not told to someone who does not own it")
	assert.Equal(t, float64(2), chk["rows"])
}

// #12158: the surface of an action is what the page said in X-Coral-Surface, kept only when it is one of the two words, on the routes that record the Operator's own actions.
func TestTheSurfaceHeaderIsKeptOnlyAsOneOfTwoWords(t *testing.T) {
	e := newReviewEnv(t, true)
	act := e.activityServer(t, true)
	e.tag(t, `["for review"]`)
	for _, tc := range []struct{ decision, header, want string }{{"save", "inbox", "inbox"}, {"unsave", "chat", "chat"}, {"ignore", "Inbox", ""}, {"unignore", "<b>x</b>", ""}, {"save", "", ""}} {
		req, _ := http.NewRequest("POST", e.srv.URL+"/api/board/alpha/artifacts/"+e.id+"/review", strings.NewReader(`{"decision":"`+tc.decision+`"}`))
		req.Header.Set("Content-Type", "application/json")
		if tc.header != "" {
			req.Header.Set("X-Coral-Surface", tc.header)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode, tc.decision)
		_, out := getActivity(t, act.URL, "?limit=1", nil)
		got, _ := out["actions"].([]any)[0].(map[string]any)["surface"].(string)
		assert.Equal(t, tc.want, got, tc.decision+" with "+tc.header)
	}
	assert.Equal(t, "", surfaceOf(httptest.NewRequest("GET", "/", nil)))
}
