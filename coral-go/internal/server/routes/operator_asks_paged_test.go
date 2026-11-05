package routes

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
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

// QA's boundaries for the pager (#13188).
func TestPageOperatorAsksBoundaries(t *testing.T) {
	mk := func(n int) []operatorAskRow {
		var rows []operatorAskRow
		for i := 0; i < n; i++ {
			rows = append(rows, operatorAskRow{Board: "b", Kind: "ask", ID: int64(i + 1), At: fmt.Sprintf("2026-11-04T10:%02d:00Z", i)})
		}
		return rows
	}
	// exactly one page: has_more false, no cursor, no empty second page
	p := pageOperatorAsks(mk(5), 5, nil)
	assert.Equal(t, false, p["has_more"])
	assert.Nil(t, p["next_cursor"])
	assert.Len(t, p["asks"], 5)
	assert.Equal(t, 5, p["total"])
	// one more than a page: has_more, and the next page is the one row
	p = pageOperatorAsks(mk(6), 5, nil)
	require.Equal(t, true, p["has_more"])
	pos, ok := decodeOperatorAskPos(p["next_cursor"].(string))
	require.True(t, ok)
	p = pageOperatorAsks(mk(6), 5, &pos)
	assert.Len(t, p["asks"], 1)
	assert.Equal(t, false, p["has_more"])

	// the tie-breaks: the same time, then the board, then the id (kind between them), one row a page
	same := []operatorAskRow{
		{Board: "b2", Kind: "ask", ID: 1, At: "2026-11-04T10:00:00Z"},
		{Board: "b1", Kind: "ask", ID: 9, At: "2026-11-04T10:00:00Z"},
		{Board: "b1", Kind: "ask", ID: 3, At: "2026-11-04T10:00:00Z"},
		{Board: "b1", Kind: "wait", ID: 2, At: "2026-11-04T10:00:00Z"},
		{Board: "b0", Kind: "ask", ID: 7, At: "2026-11-04T09:00:00Z"}, // older: last
	}
	var got []string
	var after *operatorAskPos
	for i := 0; i < 8; i++ {
		pg := pageOperatorAsks(append([]operatorAskRow(nil), same...), 1, after)
		for _, a := range pg["asks"].([]operatorAskRow) {
			got = append(got, fmt.Sprintf("%s/%s/%d", a.Board, a.Kind, a.ID))
		}
		if pg["has_more"] != true {
			break
		}
		p2, ok := decodeOperatorAskPos(pg["next_cursor"].(string))
		require.True(t, ok)
		after = &p2
	}
	assert.Equal(t, []string{"b1/ask/3", "b1/ask/9", "b1/wait/2", "b2/ask/1", "b0/ask/7"}, got, "same time: board, then kind, then id; older after")

	// the 1,024-byte cursor cap: 1,024 characters is accepted, 1,028 is not, though both decode as JSON
	padded := func(chars int) string { // raw bytes = chars*3/4 of valid JSON, padded with spaces
		body := `{"a":"2026-11-04T10:00:00Z","b":"b","k":"ask","i":3}`
		raw := body + strings.Repeat(" ", chars*3/4-len(body))
		return base64.RawURLEncoding.EncodeToString([]byte(raw))
	}
	_, ok = decodeOperatorAskPos(padded(1024))
	assert.True(t, ok, "exactly 1,024 characters")
	_, ok = decodeOperatorAskPos(padded(1028))
	assert.False(t, ok, "1,028 characters")
}
