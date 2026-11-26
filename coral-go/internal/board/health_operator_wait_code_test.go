package board

import "testing"

// #17942: a post whose only @Operator is inside a code span or block, quoting the command it tells someone to use, does not wait on the Operator (message #229440 was a false alarm).
func TestAQuotedOperatorMentionInCodeIsNotAWait(t *testing.T) {
	for _, tc := range []struct {
		name, post string
		waits      bool
	}{
		{"the approval that was flagged", "Approved at `abc123`. Security: the Operator's questions go through `coral-board post --ask \"@Operator <question>\"` so they reach Needs you; nothing else waits.", false},
		{"a fenced block", "To ask:\n```\ncoral-board post --ask \"@Operator is this ok?\"\n```\nDone.", false},
		{"an unclosed fence", "Try:\n```\ncoral-board post --ask \"@Operator ok?\"", false},
		{"a waiting phrase only in code", "Run `echo needs the operator` to see it; the operator is not involved.", false},
		{"a real mention beside a quoted one", "Use `post --ask \"@Operator <q>\"`. @Operator please pick A or B.", true},
		{"a plain mention", "@Operator your call on the colour", true},
		{"a phrase in words", "The Operator decides whether this ships.", true},
	} {
		if got := WaitsOnOperator(tc.post); got != tc.waits {
			t.Errorf("%s: WaitsOnOperator = %v, want %v", tc.name, got, tc.waits)
		}
	}
}

func TestOnlyAQuestionToTheOperatorIsAWaitForTheScan(t *testing.T) {
	for text, want := range map[string]bool{
		"@Operator please pick A or B?":               true,
		"say if you want it, operator?":               true,
		"@Operator FYI the release is out":            false,
		"the operator decides this one, I will wait":  false,
		"run `coral-board post --ask @Operator why?`": false,
	} {
		if got := AsksTheOperator(text); got != want {
			t.Errorf("%q: got %v, want %v", text, got, want)
		}
	}
}
