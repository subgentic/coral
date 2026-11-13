package clitext

import "testing"

func TestWordlessMessageIsToldByItsWords(t *testing.T) {
	for _, c := range []struct {
		in   string
		less bool
	}{
		{"@Operator -", true}, {"-", true}, {"", true}, {"@Operator", true}, {"  \n- \n* \n", true}, {"@Operator 1.", true}, {"• ", true},
		{"@Operator - ok?", false}, {"@Operator Is the build green?", false}, {"- item one", false}, {"done", false}, {"42", false}, {"ok", false},
	} {
		if got := WordlessMessage(c.in) != ""; got != c.less {
			t.Errorf("WordlessMessage(%q) wordless=%v, want %v", c.in, got, c.less)
		}
	}
}

// The refusal teaches the way to ask (Operator requirement, #16186): pinned word for word.
func TestWordlessGuidanceIsPinned(t *testing.T) {
	want := "this post has no words after the mention, so nothing was sent.\n" +
		"Put the question text in the argument:\n" +
		"  coral-board post --ask \"Operator, should I ...?\" --yes-no\n" +
		"For long text, write it to a file and use --file:\n" +
		"  coral-board post --ask --file question.md\n" +
		"A lone '-' reads the text from stdin only when it is the only word, as in: coral-board post --ask - <<'EOF' ... EOF (the mention goes inside the text)."
	if WordlessGuidance != want {
		t.Errorf("guidance changed:\n%s", WordlessGuidance)
	}
}
