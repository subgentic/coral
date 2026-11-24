package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/limitwaits"
	"github.com/subgentic/coral/internal/store"
)

// #21020: GET /api/analytics/limit-waits, the cost page's Limit waits card: the Operator's alone, counts per agent and day for a range and a team, strict about its query.

type lwRig struct {
	t *testing.T
	h *LimitWaitsHandler
	s *limitwaits.Store
}

var lwNow = time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)

func newLWRig(t *testing.T) *lwRig {
	t.Helper()
	st, err := limitwaits.Open(filepath.Join(t.TempDir(), "limit_waits.db"))
	require.NoError(t, err)
	t.Cleanup(func() { st.Close() })
	h := NewLimitWaitsHandler(st)
	h.now = func() time.Time { return lwNow }
	h.loc = time.UTC
	return &lwRig{t: t, h: h, s: st}
}

func (r *lwRig) wait(agent, team string, start time.Time, kind string) {
	r.t.Helper()
	id, err := r.s.Begin(limitwaits.Wait{SessionID: "sid-" + agent, Agent: agent, Team: team, Vendor: "claude", StartedAt: start, ResetAt: start.Add(time.Hour)})
	require.NoError(r.t, err)
	if kind != "" {
		require.NoError(r.t, r.s.End(id, start.Add(time.Hour), kind))
	}
}

func (r *lwRig) get(query url.Values, mod func(*http.Request) *http.Request) (int, map[string]any) {
	r.t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/analytics/limit-waits?"+query.Encode(), nil)
	if mod != nil {
		req = mod(req)
	}
	rec := httptest.NewRecorder()
	r.h.Read(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func lwTime(day, hh int) time.Time { return time.Date(2026, 11, day, hh, 0, 0, 0, time.UTC) }

func TestTheLimitWaitsReadIsTheOperatorsAloneAndAnAgentIsRefused(t *testing.T) {
	resetOwnerState(t)
	withLabel(t, ownerLabel, nil)
	r := newLWRig(t)
	code, out := r.get(q("days", "7"), person)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, true, out["tracking"])
	asAgent := func(req *http.Request) *http.Request {
		const sid = "11111111-2222-4333-8444-555555555555"
		return person(req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: sid, SessionName: "claude-" + sid})))
	}
	code, out = r.get(q("days", "7"), asAgent)
	assert.Equal(t, http.StatusForbidden, code, "an agent's token is refused: %v", out)
	assert.Nil(t, out["rows"])
	code, _ = r.get(q("days", "7"), nil)
	assert.Equal(t, http.StatusForbidden, code, "a request with no caller kind is not served either")
}

func TestTheLimitWaitsReadCountsPerAgentAndDayForTheRangeAndTheTeam(t *testing.T) {
	resetOwnerState(t)
	withLabel(t, ownerLabel, nil)
	r := newLWRig(t)
	// the approved mock's run (#21017) on the 23rd and 22nd, one wait today, and one old one
	r.wait("Lead Developer", "alpha", lwTime(23, 9), limitwaits.EndedAtReset)
	r.wait("Lead Developer", "alpha", lwTime(23, 10), limitwaits.EndedAtReset)
	r.wait("Lead Developer", "alpha", lwTime(23, 13), limitwaits.EndedEarly)
	r.wait("QA Engineer", "alpha", lwTime(23, 10), limitwaits.EndedAtReset)
	r.wait("QA Engineer", "alpha", lwTime(23, 15), limitwaits.EndedAtReset)
	r.wait("Lead Developer", "alpha", lwTime(22, 8), limitwaits.EndedAtReset)
	r.wait("Lead Developer", "alpha", lwTime(22, 14), limitwaits.EndedEarly)
	r.wait("Backend Dev", "beta", lwTime(24, 9), "") // today, still waiting
	r.wait("Old", "alpha", lwTime(10, 9), limitwaits.EndedAtReset)
	code, out := r.get(q("days", "7"), person)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, map[string]any{"waits": 8.0, "at_reset": 5.0, "early": 2.0}, out["totals"], "the 10th is outside seven days (the 18th to the 24th)")
	assert.Equal(t, 1.0, out["waiting"])
	rows := out["rows"].([]any)
	require.Len(t, rows, 4)
	first := rows[0].(map[string]any)
	assert.Equal(t, map[string]any{"agent": "Backend Dev", "day": "2026-11-24", "waits": 1.0, "at_reset": 0.0, "early": 0.0}, first, "newest day first")
	assert.Equal(t, map[string]any{"agent": "Lead Developer", "day": "2026-11-23", "waits": 3.0, "at_reset": 2.0, "early": 1.0}, rows[1])
	assert.Equal(t, 7.0, out["days_asked"])
	// one day: today only; one team: only its waits
	_, today := r.get(q("days", "1"), person)
	assert.Equal(t, map[string]any{"waits": 1.0, "at_reset": 0.0, "early": 0.0}, today["totals"])
	_, alpha := r.get(q("days", "30", "team", "alpha"), person)
	assert.Equal(t, map[string]any{"waits": 8.0, "at_reset": 6.0, "early": 2.0}, alpha["totals"], "thirty days of alpha: the old wait too, beta's wait out")
	assert.Equal(t, "alpha", alpha["team"])
	// no days asked: seven; more than the record keeps: cut to what it keeps
	_, dflt := r.get(q(), person)
	assert.Equal(t, 7.0, dflt["days_asked"])
	_, many := r.get(q("days", "9999"), person)
	assert.Equal(t, float64(limitwaits.KeepDays), many["days_asked"])
}

func TestTheLimitWaitsDayIsThisComputersDay(t *testing.T) {
	resetOwnerState(t)
	withLabel(t, ownerLabel, nil)
	r := newLWRig(t)
	r.h.loc = time.FixedZone("east", 2*3600)                                                                    // 12:00 UTC is 14:00 on the 24th there
	r.wait("Lead Developer", "alpha", time.Date(2026, 11, 23, 23, 30, 0, 0, time.UTC), limitwaits.EndedAtReset) // 01:30 on the 24th there
	code, out := r.get(q("days", "1"), person)
	require.Equal(t, http.StatusOK, code, "%v", out)
	rows := out["rows"].([]any)
	require.Len(t, rows, 1, "today there starts at 22:00 UTC the day before")
	assert.Equal(t, "2026-11-24", rows[0].(map[string]any)["day"])
}

func TestTheLimitWaitsReadIsStrictAboutItsQuery(t *testing.T) {
	resetOwnerState(t)
	withLabel(t, ownerLabel, nil)
	r := newLWRig(t)
	for name, query := range map[string]url.Values{"zero days": q("days", "0"), "negative days": q("days", "-3"), "days that is a word": q("days", "week"), "a team with a slash": q("team", "../x"), "a team with a space": q("team", "a b")} {
		code, _ := r.get(query, person)
		assert.Equal(t, http.StatusBadRequest, code, name)
	}
}

func TestTheLimitWaitsReadWithNoRecordSaysNothingIsTrackedAndCountsNothing(t *testing.T) {
	resetOwnerState(t)
	withLabel(t, ownerLabel, nil)
	h := NewLimitWaitsHandler(nil)
	req := person(httptest.NewRequest(http.MethodGet, "/api/analytics/limit-waits?days=7", nil))
	rec := httptest.NewRecorder()
	h.Read(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	var out map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	assert.Equal(t, false, out["tracking"])
	assert.Equal(t, map[string]any{"waits": 0.0, "at_reset": 0.0, "early": 0.0}, out["totals"])
	assert.Equal(t, []any{}, out["rows"], "an empty list, not null")
}
