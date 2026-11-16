// Package askpage is the fixed list of Coral pages a question card may offer a button for (#18768): coral-agent ask --open <page>. A name from this list and nothing else: never a URL or a path, so a card
// can send the Operator only to a page of Coral itself.
package askpage

import "strings"

// Pages are the names, with the words on the button ("Open Analytics"). The dashboard maps each to its own route.
var Pages = []struct{ Name, Label string }{
	{"analytics", "Open Analytics"},
	{"settings", "Open Settings"},
	{"inbox", "Open Needs you"},
}

// Label is the button's words for a page name, "" when the name is not on the list.
func Label(name string) string {
	for _, p := range Pages {
		if p.Name == name {
			return p.Label
		}
	}
	return ""
}

// Names lists the pages for a usage text or an error.
func Names() string {
	var n []string
	for _, p := range Pages {
		n = append(n, p.Name)
	}
	return strings.Join(n, ", ")
}
