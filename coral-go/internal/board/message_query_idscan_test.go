package board

import (
	"context"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9744: a plain text search reads each message's id and text once and matches in Go (queryTextByIDs). It answers what the scan of whole rows answers, for every needle the old LIKE path had to hand over to the scan
// (a needle that is not ASCII, a message with a NUL, a U+212A) and where the scan is cut off by its caps (the same messages, the same total, the same Truncated).
func TestTextSearchByIDsAnswersAsTheWholeRowScan(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	_, err := sub(s, ctx, "proj", "dev", "Dev")
	require.NoError(t, err)
	texts := []string{"École normale ÉCOLE", "progress report", "PROGRESS again", "naïve café Résumé", "100% done_ok", "no match here", "straße STRASSE", "İstanbul ıi", "a Kelvin " + string(rune(0x212A)) + " sign", "日本語 検索 テスト", "back\\slash"}
	for i := 0; i < 80; i++ {
		_, err := s.PostMessage(ctx, "proj", "dev", fmt.Sprintf("%s #%d", texts[i%len(texts)], i), nil)
		require.NoError(t, err)
	}
	_, err = s.db.ExecContext(ctx, `UPDATE board_messages SET content = 'head' || char(0) || ' progress after the NUL' WHERE id = (SELECT MIN(id) + 5 FROM board_messages)`)
	require.NoError(t, err)

	compare := func(needle string) {
		for _, sort := range []string{"newest", "oldest"} {
			p := MessageQueryParams{Q: []string{needle}, Sort: []string{sort}, Limit: []string{"5"}}
			a, b := queryBoth(t, s, p)
			require.Equal(t, b, a, "%q %s", needle, sort)
			for pages, cur := 0, a.NextCursor; cur != "" && pages < 40; pages++ {
				p.Cursor = []string{cur}
				a, b = queryBoth(t, s, p)
				require.Equal(t, b, a, "%q %s page", needle, sort)
				cur = a.NextCursor
			}
		}
	}
	for _, needle := range []string{"école", "ÉCOLE", "naïve", "résumé", "straße", "strasse", "istanbul", "ıi", "kelvin", "日本語", "検索", "progress", "100%", "zzz", "\\"} {
		compare(needle)
	}

	// the scan's caps: both answer the first messages up to the cap, say Truncated, and count the matches they saw
	old := messageScanRows
	t.Cleanup(func() { messageScanRows = old })
	messageScanRows = 30
	for _, needle := range []string{"progress", "école", "no match"} {
		compare(needle)
		a, b := queryBoth(t, s, MessageQueryParams{Q: []string{needle}, Limit: []string{"200"}})
		assert.True(t, a.Truncated, needle)
		assert.Equal(t, b.Truncated, a.Truncated)
		assert.Equal(t, b.Total, a.Total, "the matches within the cap: %q", needle)
	}
	messageScanRows = old
	var total int64
	require.NoError(t, s.db.GetContext(ctx, &total, `SELECT SUM(LENGTH(CAST(content AS BLOB))) FROM board_messages`))
	oldBytes := messageScanBytes
	t.Cleanup(func() { messageScanBytes = oldBytes })
	messageScanBytes = int(total) / 2
	for _, needle := range []string{"progress", "école"} {
		compare(needle)
		a, b := queryBoth(t, s, MessageQueryParams{Q: []string{needle}, Limit: []string{"200"}})
		assert.True(t, a.Truncated, "the bytes cap: %q", needle)
		assert.Equal(t, b.Total, a.Total)
	}
}
