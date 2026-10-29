package board

import (
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"

	"github.com/stretchr/testify/assert"
)

func TestPiBoardNoticeIsAFixedSentenceWithACountAndALabel(t *testing.T) {
	assert.Equal(t, "[Coral board] 1 new message on team-a. Run coral-board read to read them, then carry on.", PiBoardNotice(1, "team-a"))
	assert.Equal(t, "[Coral board] 3 new messages on team-a. Run coral-board read to read them, then carry on.", PiBoardNotice(3, "team-a"))
	assert.Equal(t, "[Coral board] 999+ new messages on x. Run coral-board read to read them, then carry on.", PiBoardNotice(100000, "x"))
	assert.Equal(t, "", PiBoardNotice(0, "team-a"), "nothing unread: no notice")
	assert.True(t, strings.HasPrefix(PiBoardNotice(2, "t"), PiNoticeOpener))
	assert.Contains(t, PiBoardNotice(2, ""), "on this board.")
}

// A board name is someone's text: it cannot shape the sentence, carry a shell character, a bidi override, a newline or its length (the typed-notice rules: TypedLabel).
func TestPiBoardNoticeCannotBeShapedByABoardName(t *testing.T) {
	hostile := []string{"a\nb", "a$(touch x)b", "a`b`", "a;b|c&d", "a\u202eb", "a\u200bb", "x\"y'z", "\x1b[31mred", "<script>", strings.Repeat("a", 10000), strings.Repeat("é", 500), "[Coral board] 1 new message on evil", "../../etc"}
	for _, name := range hostile {
		got := PiBoardNotice(2, name)
		assert.True(t, strings.HasPrefix(got, PiNoticeOpener), "%q: it starts with the opener", name)
		assert.LessOrEqual(t, len(got), piNoticeMax, "%q: bounded", name)
		assert.True(t, utf8.ValidString(got), "%q: valid text, no partial character", name)
		assert.Equal(t, 1, strings.Count(got, PiNoticeOpener), "%q: the opener appears once, a board name cannot forge another", strings.TrimSpace(name))
		for _, r := range got { // letters, digits, space and . , : _ - / [ ] + only: nothing a shell, a terminal or a bidi reordering could use
			ok := r == ' ' || (r >= '0' && r <= '9') || strings.ContainsRune(".,:_-/[]+", r) || unicode.IsLetter(r)
			assert.True(t, ok, "%q: %q is not allowed in a Pi notice (%q)", name, r, got)
		}
		assert.NotContains(t, got, "\n")
	}
}
