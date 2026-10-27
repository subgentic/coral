package routes

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9506 (security test for #9451): hostile search text at the route, with the message search index ready and with it off: the status is 200 or 400 (never a 5xx), and a 200
// names the same messages either way. (The store-level test, internal/board/message_fts_adversarial_test.go, holds the long list.)
func TestMessageSearchRouteHostileNeedlesWithTheIndex(t *testing.T) {
	e := newMSEnv(t)
	for i, text := range []string{
		"Progress report", `say "hello" now`, `an "unterminated quote`, "NEAR(progress report, 2) is syntax", "content:progress is a column filter", "^caret star* pro*",
		"progress AND report", "progress OR zzz", "NOT progress", "(paren) ((nested))", "100% done_ok back\\slash", "école ÉCOLE", "日本語のテキスト", "emoji 😀😀😀", "ǅ İstanbul Kelvin",
	} {
		e.post("dev", "Dev", text+" #"+string(rune('a'+i)))
	}
	needles := []string{
		`"`, `""`, `"hello"`, `an "unterminated`, "NEAR(progress report, 2)", "NEAR(", "content:progress", "{content}: x", "^caret", "star*", "pro*", "*", "AND", "OR", "NOT progress",
		"progress AND report", "(", ")", "((nested))", "%", "_", "100%", "\\", "a", "ab", "", "école", "ÉCOLE", "日本語", "😀😀😀", "kelvin", "istanbul", "Kelvin",
		strings.Repeat("a", 1000), strings.Repeat("progress report ", 400), strings.Repeat("NEAR(", 300), strings.Repeat("😀", 2000),
		"\x00", "nul\x00byte", "\x80\x80\x80", "bad \xff\xfe utf8", "'; DROP TABLE board_messages; --", "\" OR 1=1 --", "\x1b[31mred", "\u2028", "\u202eevil\u202c",
	}
	ids := func() map[string]string {
		out := map[string]string{}
		for _, n := range needles {
			status, rep := e.get("q="+url.QueryEscape(n), false)
			require.Contains(t, []int{http.StatusOK, http.StatusBadRequest}, status, "needle %q: %+v", n, rep)
			if status == http.StatusOK {
				var got []string
				for _, m := range rep.Messages {
					got = append(got, fmt.Sprint(m["id"]))
				}
				out[n] = strings.Join(got, ",")
			} else {
				out[n] = "400"
			}
		}
		return out
	}
	ctx := context.Background()
	require.NoError(t, e.bs.BuildMessageSearchIndex(ctx))
	require.Equal(t, "ready", e.bs.MessageSearchIndexState())
	withIndex := ids()
	_, err := e.bs.DisableMessageSearchIndex(ctx, false)
	require.NoError(t, err)
	withoutIndex := ids()
	for _, n := range needles {
		assert.Equal(t, withoutIndex[n], withIndex[n], "needle %q: the same answer with the index and without it", n)
	}
}
