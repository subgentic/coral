package ptymanager

import (
	"testing"

	"github.com/subgentic/coral/internal/typedcensus"
)

// The line Coral types for the notices it held (#11387) is a typed notice like the others: a fixed opener, counts and fixed words only, so no hostile text can reach a shell or a terminal through it.
func TestTypedNoticeCensus(t *testing.T) {
	typedcensus.Run(t, []typedcensus.Case{
		typedcensus.C("held notices, one kind", heldSummary(map[string]int{"board message": 1}), heldSummary(map[string]int{typedcensus.Hostile: 1})),
		typedcensus.C("held notices, several kinds", heldSummary(map[string]int{"board message": 3, "task notification": 1, "board wait timeout": 2}), heldSummary(map[string]int{"board message": 3, typedcensus.Hostile: 2})),
		typedcensus.C("held notices, a flood", heldSummary(map[string]int{"board message": 100000}), heldSummary(map[string]int{"board nudge": 100000})),
	})
}

// Every call in this package that types text into an agent's terminal, and where its text comes from. A new call fails here until its text comes from a census builder and it is listed.
func TestEveryTypedSenderIsInTheCensus(t *testing.T) {
	typedcensus.CheckSites(t, ".", []typedcensus.Site{
		typedcensus.S("notice_pause.go", `terminalinput.Coral, tmpl.Name, text`, 1, "the one line for held notices (census: held notices): counts and fixed words from heldSummary, typed through DeliverAutomated like any notice"),
		typedcensus.S("automated_input_deliver.go", `terminalinput.Coral, in.Name, in.Text`, 1, "the gate itself: it types the text of its callers, each in its own package's census (the gate is listed in the repo census' coralOriginFiles)"),
	})
}
