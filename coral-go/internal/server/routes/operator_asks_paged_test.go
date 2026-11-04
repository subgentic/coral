package routes

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13188: pageOperatorAsks cuts the open questions newest first, with the true total and a cursor that continues with no gap and no repeat, even when two questions share a time.
func TestPageOperatorAsksWalksTheWholeListNewestFirst(t *testing.T) {
	var rows []operatorAskRow
	for i := 0; i < 23; i++ {
		rows = append(rows, operatorAskRow{Board: fmt.Sprintf("b%d", i%3), Kind: "ask", ID: int64(i + 1), At: fmt.Sprintf("2026-11-04T10:%02d:00Z", i/2)}) // pairs share a time
	}
	seen := map[string]bool{}
	var after *operatorAskPos
	pages, last := 0, ""
	for {
		p := pageOperatorAsks(append([]operatorAskRow(nil), rows...), 5, after)
		assert.Equal(t, 23, p["total"])
		asks := p["asks"].([]operatorAskRow)
		pages++
		for _, a := range asks {
			key := fmt.Sprintf("%s/%d", a.Board, a.ID)
			require.False(t, seen[key], "sent once: "+key)
			seen[key] = true
			if last != "" {
				assert.GreaterOrEqual(t, last, a.At, "newest first")
			}
			last = a.At
		}
		if p["has_more"] != true {
			assert.Nil(t, p["next_cursor"])
			break
		}
		require.Len(t, asks, 5)
		pos, ok := decodeOperatorAskPos(p["next_cursor"].(string))
		require.True(t, ok)
		after = &pos
		require.Less(t, pages, 8)
	}
	assert.Len(t, seen, 23)
	assert.Equal(t, 5, pages)

	empty := pageOperatorAsks(nil, 50, nil)
	assert.Equal(t, 0, empty["total"])
	assert.Empty(t, empty["asks"])

	for _, bad := range []string{"", "!!!", "e30"} { // not base64url JSON with a time and an id
		_, ok := decodeOperatorAskPos(bad)
		assert.False(t, ok, bad)
	}
}

// The route: without paged it is the bare array it was (limit and cursor ignored); with paged=1 it is {asks, total, has_more, next_cursor}.
func TestOperatorAsksPagedIsOptInAndTheBareArrayIsUnchanged(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := t.Context()
	for _, who := range []string{"Lead", "Operator"} {
		_, err := bs.Subscribe(ctx, "team", who, who, "", nil, "all")
		require.NoError(t, err)
	}
	for i := 0; i < 5; i++ {
		q, err := bs.PostMessage(ctx, "team", "Lead", fmt.Sprintf("@Operator question %d?", i), nil)
		require.NoError(t, err)
		if to, err := bs.AskTargets(ctx, "team", "Lead", q.Content); err == nil {
			require.NoError(t, bs.RecordAsk(ctx, "team", q, to))
		}
	}
	read := func(query string) (int, []byte) {
		req := asPerson(httptest.NewRequest(http.MethodGet, "/api/operator-asks"+query, nil))
		w := httptest.NewRecorder()
		h.OperatorAsks(w, req)
		return w.Code, w.Body.Bytes()
	}
	code, raw := read("?limit=2&cursor=ignored")
	require.Equal(t, http.StatusOK, code)
	var bare []map[string]any
	require.NoError(t, json.Unmarshal(raw, &bare), "still a bare array")
	assert.Len(t, bare, 5, "limit and cursor without paged change nothing")

	code, raw = read("?paged=1&limit=2")
	require.Equal(t, http.StatusOK, code)
	var p struct {
		Asks       []map[string]any `json:"asks"`
		Total      int              `json:"total"`
		HasMore    bool             `json:"has_more"`
		NextCursor string           `json:"next_cursor"`
	}
	require.NoError(t, json.Unmarshal(raw, &p))
	assert.Len(t, p.Asks, 2)
	assert.Equal(t, 5, p.Total)
	assert.True(t, p.HasMore)
	assert.NotEmpty(t, p.NextCursor)

	for _, bad := range []string{"?paged=2", "?paged=1&limit=0", "?paged=1&limit=201", "?paged=1&cursor=!!!"} {
		code, _ = read(bad)
		assert.Equal(t, http.StatusBadRequest, code, bad)
	}
}
