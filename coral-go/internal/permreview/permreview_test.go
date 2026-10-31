package permreview

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestACleanRequestIsShownWholeAndMayBeAllowed(t *testing.T) {
	for _, n := range []int{1, 400, 600, MaxBytes} {
		text := strings.Repeat("a", n)
		r := Of(text)
		assert.Equal(t, text, r.Shown, "%d bytes", n)
		assert.True(t, r.Allowed(), "%d bytes", n)
		assert.Empty(t, r.Note())
	}
	multi := "git log\n\t--oneline\n  | head"
	assert.Equal(t, multi, Of(multi).Shown, "a newline and a tab are ordinary")
	assert.True(t, Of(multi).Allowed())
	assert.True(t, Of("echo héllo 日本語 ✓").Allowed(), "ordinary non-ASCII text is fine")
}

func TestARequestLongerThanTheLimitSaysSoAndCannotBeAllowed(t *testing.T) {
	r := Of(strings.Repeat("a", MaxBytes+1))
	assert.True(t, r.Cut)
	assert.False(t, r.Allowed())
	assert.Len(t, r.Shown, MaxBytes)
	assert.Contains(t, r.Note(), "longer than the 4000 bytes")
	assert.Contains(t, r.Note(), "cannot be allowed from here")

	// cut at a character boundary, never in the middle of one
	r = Of(strings.Repeat("é", MaxBytes)) // 2 bytes each: 8000 bytes
	assert.True(t, r.Cut)
	assert.LessOrEqual(t, len(r.Shown), MaxBytes)
	assert.NotContains(t, r.Shown, "\uFFFD")
}

func TestACharacterThatHidesWhatARequestDoesIsWrittenOutAndCannotBeAllowed(t *testing.T) {
	for name, c := range map[string]string{"right-to-left override": "\u202e", "zero-width space": "\u200b", "bidi isolate": "\u2066", "ESC": "\x1b", "carriage return": "\r", "NUL": "\x00", "BOM": "\ufeff", "soft hyphen": "\u00ad", "line separator mark": "\u200e"} {
		text := "rm -rf " + c + "/safe/folder"
		r := Of(text)
		require.True(t, r.Hidden, name)
		assert.False(t, r.Allowed(), name)
		assert.NotContains(t, r.Shown, c, "%s: never shown raw", name)
		assert.Contains(t, r.Shown, "<U+", "%s: written out so the person can see it", name)
		assert.Contains(t, r.Note(), "can hide what it does", name)
	}
	r := Of("echo hi \u202e")
	assert.Equal(t, "echo hi <U+202E>", r.Shown)
}

func TestAHiddenCharacterBeyondTheCutStillMakesItUnallowable(t *testing.T) {
	r := Of(strings.Repeat("a", MaxBytes+10) + "\u202e")
	assert.True(t, r.Cut)
	assert.True(t, r.Hidden, "seen after the cut: the whole request is judged, not only what is shown")
	assert.Contains(t, r.Note(), "longer")
	assert.Contains(t, r.Note(), "hide")
}

func TestInvalidUTF8IsNotShownAsItIs(t *testing.T) {
	r := Of("ab\xffcd")
	assert.Equal(t, "ab\uFFFDcd", r.Shown)
	assert.True(t, r.Allowed(), "a bad byte is replaced where it is read: it hides nothing")
}

func TestPatternsAreListedUpToTheLimitAndTheRestCounted(t *testing.T) {
	var ps []string
	for i := 0; i < MaxPatterns+3; i++ {
		ps = append(ps, "pattern")
	}
	shown, more, r := Patterns(ps)
	assert.Len(t, shown, MaxPatterns)
	assert.Equal(t, 3, more)
	assert.Equal(t, "and 3 more patterns", MoreNote(more))
	assert.Equal(t, "and 1 more pattern", MoreNote(1))
	assert.Equal(t, "", MoreNote(0))
	assert.True(t, r.Allowed())

	_, _, bad := Patterns([]string{"ok", "no\u202eway"})
	assert.True(t, bad.Hidden)
	_, _, cut := Patterns([]string{strings.Repeat("x", MaxBytes+1)})
	assert.True(t, cut.Cut)
	assert.False(t, Merge(Of("fine"), Of("bad\u200b")).Allowed(), "allowed only when every piece is")
	assert.True(t, Merge(Of("a"), Of("b")).Allowed())
}

func TestACharacterThatDrawsAsNothingOrAsASpaceIsWrittenOutAndCannotBeAllowed(t *testing.T) {
	for name, c := range map[string]string{"hangul filler": "\u3164", "hangul choseong filler": "\u115f", "hangul jungseong filler": "\u1160", "halfwidth hangul filler": "\uffa0", "braille blank": "\u2800", "no-break space": "\u00a0", "em space": "\u2003", "line separator": "\u2028", "paragraph separator": "\u2029", "ideographic space": "\u3000", "grapheme joiner": "\u034f", "khmer vowel inherent aq": "\u17b4", "khmer vowel inherent aa": "\u17b5"} {
		r := Of("cat /etc/pass" + c + "wd")
		require.True(t, r.Hidden, name)
		assert.False(t, r.Allowed(), name)
		assert.NotContains(t, r.Shown, c, "%s: never shown raw", name)
		assert.Contains(t, r.Shown, "<U+", name)
	}
	r := Of("cat /my\u00a0files/a")
	assert.Equal(t, "cat /my<U+00A0>files/a", r.Shown, "a no-break space inside a path is shown")
	assert.False(t, r.Allowed())
	assert.True(t, Of("cat /my files/a").Allowed(), "an ordinary space is fine")
}

func TestALongRunOfBlanksIsHiddenAndShownAsItsLength(t *testing.T) {
	r := Of("echo ok" + strings.Repeat(" ", 3000) + "; rm -rf ~")
	assert.True(t, r.Hidden)
	assert.False(t, r.Allowed())
	assert.Equal(t, "echo ok<3000 blanks>; rm -rf ~", r.Shown)

	r = Of("a" + strings.Repeat(" ", BlankRun) + "b")
	assert.Equal(t, "a<40 blanks>b", r.Shown, "the limit itself counts")
	assert.False(t, r.Allowed())
	r = Of("a" + strings.Repeat(" \n", BlankRun/2) + "b")
	assert.True(t, r.Hidden, "spaces and newlines together are one run")

	r = Of("a" + strings.Repeat(" ", BlankRun-1) + "b")
	assert.True(t, r.Allowed(), "one short of the limit is ordinary indentation")
	assert.Equal(t, "a"+strings.Repeat(" ", BlankRun-1)+"b", r.Shown)

	r = Of(strings.Repeat("a", MaxBytes+5) + strings.Repeat(" ", 100))
	assert.True(t, r.Cut)
	assert.True(t, r.Hidden, "a blank run beyond the cut is judged too")
}

func TestTheCleanFourHundredByteCommandIsStillAllowed(t *testing.T) {
	text := strings.Repeat("go test ./... && ", 30)[:400]
	r := Of(text)
	assert.True(t, r.Allowed())
	assert.Equal(t, text, r.Shown)
}

func TestAWindowsLineEndIsANewlineButALoneCRStaysHidden(t *testing.T) {
	r := Of("echo a\r\necho b\r\n")
	if r.Hidden || r.Cut {
		t.Fatalf("CRLF is a newline: %+v", r)
	}
	if r.Shown != "echo a\necho b\n" {
		t.Fatalf("the CR before a LF is dropped from the shown text: %q", r.Shown)
	}
	for _, s := range []string{"echo safe\rrm -rf ~", "echo ok\r", "a\r\r\nb"} {
		if !Of(s).Hidden {
			t.Errorf("%q: a CR not followed by a LF hides what it overwrote", s)
		}
	}
	// a request cut at MaxBytes, with a lone CR beyond the cut, is hidden too
	if !Of(strings.Repeat("x", MaxBytes+10) + "\rrm").Hidden {
		t.Error("a lone CR after the cut")
	}
}
