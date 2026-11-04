package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// #13186: the live list is the dashboard's biggest answer, and two thirds of its bytes were keys with an empty value. ?compact=1 (asked by the dashboard's own load; every other caller, the Hub among them, keeps today's
// shape) leaves out the keys whose value is null; a key that is there says exactly what it said, and false and 0 stay (a missing awaiting_user would read as the stop-derived one). The size budget below fails when a row grows.
func liveListRig(t *testing.T) *SessionsHandler {
	_, h, mock, ss := setupSessionsTestServer(t)
	h.terminal = orderedTerm{mock}
	team := "team-a"
	for i := 0; i < 45; i++ { // 30 awake and 15 asleep, the size of QA's seed (#13154)
		typ := []string{"claude", "codex", "pi"}[i%3]
		sid := fmt.Sprintf("%08x-1123-4000-8000-%012x", i+1, i)
		dir := fmt.Sprintf("/tmp/load-%d", i)
		sleeping := 0
		if i >= 30 {
			sleeping = 1
		} else {
			mock.addSession(naming.SessionName(typ, sid), dir)
		}
		require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: typ, AgentName: fmt.Sprintf("agent-%d", i), WorkingDir: dir, IsSleeping: sleeping, BoardName: &team}))
	}
	return h
}

func liveListBody(t *testing.T, h *SessionsHandler, query string) (string, []map[string]any) {
	rec := httptest.NewRecorder()
	h.List(rec, httptest.NewRequest(http.MethodGet, "/api/sessions/live"+query, nil))
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var rows []map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &rows))
	return rec.Body.String(), rows
}

func TestACompactLiveListLeavesOutNullKeysAndNothingElse(t *testing.T) {
	h := liveListRig(t)
	full, fullRows := liveListBody(t, h, "")
	compact, compactRows := liveListBody(t, h, "?compact=1")
	require.Len(t, fullRows, 45)
	require.Len(t, compactRows, len(fullRows))
	nulls := 0
	for i, row := range fullRows {
		for k, v := range row {
			if v == nil && k != "held_messages" {
				nulls++
				_, there := compactRows[i][k]
				assert.False(t, there, "row %d: %s is null and so is left out", i, k)
				continue
			}
			assert.Equal(t, v, compactRows[i][k], "row %d: %s says what it said", i, k)
		}
		for k := range compactRows[i] {
			_, there := row[k]
			assert.True(t, there, "a compact row has no key the full one lacks: %s", k)
		}
	}
	require.NotZero(t, nulls, "the rig has null keys to leave out")
	heldNull := 0
	for i, row := range fullRows {
		if v, there := row["held_messages"]; there && v == nil {
			heldNull++
			got, kept := compactRows[i]["held_messages"]
			assert.True(t, kept && got == nil, "row %d: held_messages null is kept: the page reads it as 'none held' and a missing key as 'not said' (#13186, QA's MUST)", i)
		}
	}
	require.NotZero(t, heldNull, "the rig has rows that say none held")
	assert.Less(t, len(compact)*10, len(full)*7, "at least 30%% of the bytes go: %d of %d", len(compact), len(full))
	_, again := liveListBody(t, h, "?compact=0")
	assert.Equal(t, fullRows, again, "anything but compact=1 is the full shape")
}

// The size budget (#13186, QA's seed of 30 awake and 15 sleeping agents): a row and a list may not grow past these without someone raising them on purpose. The full shape is the Hub's contract and is only bounded.
func TestTheLiveListStaysWithinItsSizeBudget(t *testing.T) {
	h := liveListRig(t)
	full, rows := liveListBody(t, h, "")
	compact, _ := liveListBody(t, h, "?compact=1")
	const fullPerRow, compactPerRow, keysPerRow = 2000, 1100, 90
	assert.LessOrEqual(t, len(full)/len(rows), fullPerRow, "the full list's bytes per row (%d)", len(full)/len(rows))
	assert.LessOrEqual(t, len(compact)/len(rows), compactPerRow, "the compact list's bytes per row (%d)", len(compact)/len(rows))
	most := 0
	for _, r := range rows {
		most = max(most, len(r))
	}
	assert.LessOrEqual(t, most, keysPerRow, "keys in the widest row (%d)", most)
}
