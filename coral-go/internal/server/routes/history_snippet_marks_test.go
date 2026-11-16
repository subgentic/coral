package routes

import (
	"testing"

	"github.com/subgentic/coral/internal/store"
)

// A search's hit line is the chat's own words (#17801, walk 78): the FTS excerpt of a transcript carried its markdown marks (** and backticks) into the Chats page.
func TestPlainSnippetDropsMarkdownMarks(t *testing.T) {
	for in, want := range map[string]string{
		"ticket **PLUM-4471** is about the `billing` deploy": "ticket PLUM-4471 is about the billing deploy",
		"## Plan\nthe ~~old~~ plan":                          "Plan\nthe old plan",
		"snake_case and a * b stay":                          "snake_case and a * b stay",
		"__init__ and snake__case_name stay":                 "__init__ and snake__case_name stay",
		"a __two words__ b":                                  "a two words b",
		"__bold words__":                                     "bold words",
		"__x__ and __y z__":                                  "__x__ and y z",
		"":                                                   "",
	} {
		if got := plainSnippet(in); got != want {
			t.Errorf("plainSnippet(%q) = %q, want %q", in, got, want)
		}
	}
	rows := agentHistoryRows([]store.SessionListItem{{SessionID: "s1", Snippet: "a **b** c"}})
	if rows[0]["snippet"] != "a b c" {
		t.Errorf("the row's snippet = %v, want 'a b c'", rows[0]["snippet"])
	}
}
