package store

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #10137 (Desktop #10131): a search for a hyphenated code (PLUM-4471) made FTS5 fail on the bare hyphen, the page's request failed and "Loading chats..." never ended. Every term a person can
// type is made a quoted FTS5 string, so hyphens, dots, @ and the characters FTS5 reads as syntax are words; and each hit carries a one-line snippet around the matched words.
func TestSearchTermsWithPunctuationAreWordsNotFTSSyntax(t *testing.T) {
	db := openTestDB(t)
	s := NewSessionStore(db)
	ctx := context.Background()
	bodies := map[string]string{
		"10137000-0000-4000-8000-000000000001": "the customer sent ticket PLUM-4471 about the failing deploy of the billing service\nand more lines",
		"10137000-0000-4000-8000-000000000002": "released v2.0.3 to the beta channel yesterday",
		"10137000-0000-4000-8000-000000000003": "mail from a@b.example about the budget",
		"10137000-0000-4000-8000-000000000004": "an ordinary chat about refactoring the parser",
	}
	for id, body := range bodies {
		last := "2026-10-20T10:00:00Z"
		require.NoError(t, s.UpsertSessionIndex(ctx, &SessionIndex{SessionID: id, SourceType: "claude", SourceFile: "/f/" + id, FirstTimestamp: &last, LastTimestamp: &last, MessageCount: 3, FileMtime: 1}))
		require.NoError(t, s.UpsertFTS(ctx, id, body))
	}
	find := func(q, mode string) *SessionListResult {
		t.Helper()
		res, err := s.ListSessionsPaged(ctx, SessionListParams{Search: q, FTSMode: mode})
		require.NoError(t, err, "search %q in mode %q must not be an FTS5 error", q, mode)
		return res
	}
	ids := func(r *SessionListResult) []string {
		var out []string
		for _, it := range r.Sessions {
			out = append(out, it.SessionID[len(it.SessionID)-1:])
		}
		return out
	}
	for _, mode := range []string{"", "phrase", "and", "or"} {
		assert.Equal(t, []string{"1"}, ids(find("PLUM-4471", mode)), "a hyphenated code, mode %q", mode)
		assert.Equal(t, []string{"2"}, ids(find("v2.0.3", mode)), "a version, mode %q", mode)
		assert.Equal(t, []string{"3"}, ids(find("a@b.example", mode)), "an address, mode %q", mode)
	}
	// every character FTS5 reads as syntax is a word, never an error
	for _, q := range []string{`-`, `"`, `""`, `*`, `foo*`, `(`, `)`, `a:b`, `^x`, `NEAR(a b)`, `a "b c`, `AND`, `OR`, `NOT`, `x OR`, `+`, `{x}`, `'`, `\`, `%`, `;`, `a--b`, `col:x`, `😀`, strings.Repeat("a", 500)} {
		for _, mode := range []string{"", "phrase", "and", "or"} {
			_, err := s.ListSessionsPaged(ctx, SessionListParams{Search: q, FTSMode: mode})
			assert.NoError(t, err, "search %q mode %q", q, mode)
		}
	}
	// several words still mean several words
	assert.Equal(t, []string{"1"}, ids(find("PLUM-4471 billing", "and")))
	assert.ElementsMatch(t, []string{"1", "2"}, ids(find("PLUM-4471 v2.0.3", "or")))
	assert.Empty(t, ids(find("PLUM-4471 parser", "and")), "and: every word must be there")
	assert.Equal(t, []string{"1"}, ids(find(`"failing deploy" PLUM-4471`, "and")), "a quoted phrase stays a phrase")
	assert.Equal(t, []string{"4"}, ids(find("refactor*", "and")), "a trailing star is a prefix search")

	// a one-line snippet with the matched words, per hit
	one := find("PLUM-4471", "")
	require.Len(t, one.Sessions, 1)
	sn := one.Sessions[0].Snippet
	assert.Contains(t, sn, "PLUM-4471", "the snippet shows the match")
	assert.NotContains(t, sn, "\n", "one line")
	assert.LessOrEqual(t, len([]rune(sn)), 200)
	none, err := s.ListSessionsPaged(ctx, SessionListParams{})
	require.NoError(t, err)
	for _, it := range none.Sessions {
		assert.Empty(t, it.Snippet, "no search, no snippet")
	}
	_ = fmt.Sprint
}
