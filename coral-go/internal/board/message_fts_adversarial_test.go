package board

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9506 (security test for #9451): a search needle reaches the message search index as MATCH text. messageFTSQuery quotes each trigram of the needle, so none of
// FTS5's query syntax (a quote, NEAR(), a column filter, ^, *, AND/OR/NOT, parentheses) can be written by the person searching; every needle below is also a message
// the corpus holds, so the index has something to offer, and each must answer exactly as the Go scan does or be refused by the query parser (a 4xx), never an error.

var ftsAdversarialTexts = []string{
	"Progress report", "no match here", "plain words only",
	`say "hello" now`, `an "unterminated quote`, `""`, `"`, `""" triple """`,
	"NEAR(progress report, 2) is syntax", "NEAR/3(a b)", "content:progress is a column filter", "{content}: x", "board_name:dev", "rowid:1",
	"^caret at start", "star* at end", "pro* prefix", "a * b", "-minus -progress", "+plus +progress",
	"progress AND report", "progress OR zzz", "NOT progress", "progress NOT report", "x AND y OR z", "and or not near",
	"(paren)", "((nested))", ")(", "a(b)c", "[bracket] {brace}", "back\\slash", "100% done_ok", "a_b", "50%_off",
	"ab", "a", "xy z", "é", "ß and SS", "ǅ ǆ Ǆ", "İstanbul istanbul ISTANBUL ıi", "K kelvin sign", "ſ long s", "Straße STRASSE",
	"école ÉCOLE École", "e\u0301cole combining", "naïve NAÏVE", "日本語のテキスト", "한국어 텍스트", "العربية نص", "emoji 😀😀😀 here", "👨\u200d👩\u200d👧 family",
	"zero\u200bwidth joiner", "bidi \u202eevil\u202c text", "tab\tsep\nnewline\r\nCRLF", "replacement \ufffd char",
	"A very long line: " + strings.Repeat("progress report ", 400),
}

var ftsAdversarialNeedles = []string{
	// quotes
	`"`, `""`, `"""`, `"hello"`, `"hello`, `hello"`, `say "hello" now`, `an "unterminated`, `"" "`, `'`, `'single'`, "`backtick`",
	// FTS5 operators and syntax
	"NEAR(progress report, 2)", "NEAR(", "NEAR/3(a b)", "NEAR", "near(a b)",
	"content:progress", "content: progress", "content:", ":progress", "{content}: x", "{content board_name}: x", "board_name:dev", "rowid:1", "rowid", "- content: x",
	"^caret", "^", "^^^", "star*", "pro*", "*", "**", "a * b", "-minus", "+plus", "- minus",
	"progress AND report", "progress OR zzz", "NOT progress", "progress NOT report", "AND", "OR", "NOT", "AND OR NOT", "x AND y OR z", "and or not near",
	"(paren)", "((nested))", ")(", "(", ")", "a(b)c", "[bracket]", "{brace}", "{", "}", "(((((((((((((((((((((((",
	// LIKE wildcards and escapes
	"%", "_", "%%%", "___", "100%", "a_b", "50%_off", "\\", "\\\\", "back\\slash", "\\%", "\\_",
	// length: under three characters, exactly three, long
	"", " ", "  ", "a", "ab", "abc", "xy z", "é", "éé", "日本", "日本語", "😀", "😀😀", "😀😀😀",
	strings.Repeat("a", 1000), strings.Repeat("progress report ", 400), strings.Repeat("\"", 500), strings.Repeat("NEAR(", 300), strings.Repeat("a OR ", 1000), strings.Repeat("😀", 2000),
	// unicode: case folding, normalisation, scripts, invisibles
	"ß and SS", "STRASSE", "straße", "ǅ ǆ Ǆ", "ǆ", "İstanbul", "istanbul", "ISTANBUL", "ıi", "K kelvin", "K", "ſ long", "école", "ÉCOLE", "e\u0301cole", "\u0301cole", "naïve", "NAÏVE",
	"日本語のテキスト", "한국어 텍스트", "العربية نص", "emoji 😀😀😀", "👨\u200d👩\u200d👧", "zero\u200bwidth", "\u200b\u200b\u200b", "\u202eevil\u202c", "tab\tsep", "new\nline", "CRLF\r\n", "\ufffd char", "\ufffd\ufffd\ufffd",
	// bytes that are not text: a lone continuation byte, an overlong encoding, a NUL
	"\x80\x80\x80", "bad \xff\xfe utf8 progress", "\xc0\xaf", "nul\x00byte", "\x00", "\x00\x00\x00", "pro\x00gress",
	// SQL and control text
	"'; DROP TABLE board_messages; --", "\" OR 1=1 --", "progress'; --", "%' OR '1'='1", "\x01\x02\x03", "\x1b[31mred", "\u2028\u2029",
}

func TestMessageSearchIndexAdversarialNeedlesAnswerLikeTheScan(t *testing.T) {
	s := ftsStoreWithMessages(t, ftsAdversarialTexts, 220)
	ctx := context.Background()
	require.NoError(t, s.BuildMessageSearchIndex(ctx))
	require.Equal(t, "ready", s.MessageSearchIndexState())
	viaIndex, refused, hits := 0, 0, 0
	for _, needle := range ftsAdversarialNeedles {
		for _, sort := range []string{"newest", "oldest"} {
			p := MessageQueryParams{Q: []string{needle}, Sort: []string{sort}, Limit: []string{"9"}}
			if _, err := ParseMessageQuery(p); err != nil {
				require.ErrorIs(t, err, ErrMessageQuery, "needle %q: a refusal is the parser's own (a 400 at the route), not an error (a 500)", needle)
				refused++ // the same with or without the index
				continue
			}
			before := answered(s)
			a, b := queryBothNoFail(t, s, p, needle)
			require.Equal(t, b, a, "needle %q %s: the index answered differently from the Go scan", needle, sort)
			if answered(s) > before {
				viaIndex++
			}
			if a != nil && len(a.Messages) > 0 {
				hits++
			}
		}
	}
	// the corpus holds what the needles name, so the index was exercised and found things (a test of nothing would pass without either)
	assert.Greater(t, viaIndex, 100, "needles the index answered")
	assert.Greater(t, hits, 60, "needles that matched something")
	t.Logf("%d needles x2 sorts: %d answered by the index, %d matched messages, %d refused by the parser", len(ftsAdversarialNeedles), viaIndex, hits, refused)
}

// queryBothNoFail is queryBoth that reports an error from either path as the failure it is (a search must not fail on any text), naming the needle.
func queryBothNoFail(t *testing.T, s *Store, p MessageQueryParams, needle string) (sqlRes, goRes *MessageQueryResult) {
	t.Helper()
	run := func(force bool) *MessageQueryResult {
		q, err := ParseMessageQuery(p)
		require.NoError(t, err)
		q.Project = "proj"
		if force {
			q.Shown = func(s string) string { return s }
		}
		res, err := s.QueryMessages(context.Background(), q)
		require.NoError(t, err, "needle %q (forced scan %v): a search must not fail on any text", needle, force)
		return res
	}
	return run(false), run(true)
}

// A message that holds a NUL turns the index off for every needle (LIKE stops at a NUL, Go's match does not): the answer is still the scan's. Posting strips control
// characters, so the message goes in as a row, as an older version or an import could have left it.
func TestMessageSearchIndexWithANulMessageAnswersLikeTheScan(t *testing.T) {
	s := ftsStoreWithMessages(t, ftsAdversarialTexts, 240)
	ctx := context.Background()
	require.NoError(t, s.BuildMessageSearchIndex(ctx))
	for _, content := range []string{"has a nul\x00inside progress", "\x00", "report\x00"} {
		_, err := s.db.ExecContext(ctx, `INSERT INTO board_messages(project, session_id, subscriber_id, content, created_at) VALUES ('proj', 'dev', 'dev', ?, '2026-10-27T00:00:00Z')`, content)
		require.NoError(t, err)
	}
	for _, needle := range []string{"progress", "nul", "inside", "nul\x00inside", "pro\x00gress", "report", `"`, "NEAR(a b)", "content:progress", "日本語", "ǅ", "has a nul"} {
		p := MessageQueryParams{Q: []string{needle}, Limit: []string{"9"}}
		if _, err := ParseMessageQuery(p); err != nil {
			continue
		}
		before := answered(s)
		a, b := queryBothNoFail(t, s, p, needle)
		require.Equal(t, b, a, "needle %q with a NUL message in the corpus", needle)
		require.Equal(t, before, answered(s), "needle %q: a NUL message in the corpus leaves the search to the scan", needle)
	}
}

// Go folds the case of U+212A (Kelvin sign) to k and of U+0130 and U+0131 to i; LIKE and the index's tokenizer do not agree with it: a needle with an i or a k, with such a message
// in the corpus, is answered by the scan, and every answer is the scan's.
func TestMessageSearchIndexFoldingGuardsAnswerLikeTheScan(t *testing.T) {
	s := ftsStoreWithMessages(t, ftsAdversarialTexts, 220)
	ctx := context.Background()
	require.NoError(t, s.BuildMessageSearchIndex(ctx))
	for _, text := range []string{"\u212aelvin sign", "\u0130stanbul", "\u0131stanbul dotless", "\u212a", "Kilo \u212ailo"} {
		_, err := s.PostMessage(ctx, "proj", "dev", text, nil)
		require.NoError(t, err)
	}
	for _, needle := range []string{"kelvin", "Kelvin", "elvin", "istanbul", "ISTANBUL", "stanbul", "dotless", "kilo", "KILO", "ilo", "sign", "k", "i", "kil", "ki", "\u212aelvin", "\u0130stanbul", "\u0131stanbul"} {
		p := MessageQueryParams{Q: []string{needle}, Limit: []string{"20"}}
		if _, err := ParseMessageQuery(p); err != nil {
			continue
		}
		a, b := queryBothNoFail(t, s, p, needle)
		require.Equal(t, b, a, "needle %q with U+212A, U+0130 and U+0131 in the corpus", needle)
		if strings.ContainsAny(needle, "ik") && len([]rune(needle)) >= 3 {
			require.NotZero(t, len(a.Messages), "needle %q matches a message", needle)
		}
	}
}

// What the index is built from is also text a person posts: a message holding FTS5 syntax is indexed as text, and posting and then searching it works the same.
func TestMessageSearchIndexPostedSyntaxIsText(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	_, err := sub(s, ctx, "proj", "dev", "Backend Dev")
	require.NoError(t, err)
	require.NoError(t, s.BuildMessageSearchIndex(ctx))
	for i, text := range []string{`"quoted" NEAR(a b) content:x ^y z* AND OR NOT (p)`, `""" """`, "ünï ǅ İ K 😀😀😀"} {
		_, err := s.PostMessage(ctx, "proj", "dev", fmt.Sprintf("%s #%d", text, i), nil)
		require.NoError(t, err)
	}
	for _, needle := range []string{`"quoted" NEAR(a b)`, `content:x ^y z*`, `AND OR NOT (p)`, `""" """`, "ünï ǅ İ", "😀😀😀", "NEAR(a b) content"} {
		p := MessageQueryParams{Q: []string{needle}}
		a, b := queryBothNoFail(t, s, p, needle)
		require.Equal(t, b, a, "needle %q", needle)
		assert.NotEmpty(t, a.Messages, "needle %q is a message that was just posted", needle)
	}
}
