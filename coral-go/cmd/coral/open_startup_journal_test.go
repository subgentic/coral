package main

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// The server's startup output is a journal under systemd (or a log file under the tray): the one-time login token must reach only a terminal (#21549).
func TestTheStartupSignInLinkIsNotPrintedWhereALogKeepsIt(t *testing.T) {
	const link = "http://localhost:8420/?login_token=SECRETTOKEN123"
	old := startupIsTerminal
	t.Cleanup(func() { startupIsTerminal = old })

	startupIsTerminal = func() bool { return false }
	var journal strings.Builder
	printStartupLink(&journal, link)
	assert.NotContains(t, journal.String(), "SECRETTOKEN123", "the token is not printed to a journal")
	assert.NotContains(t, journal.String(), "login_token")
	assert.Contains(t, journal.String(), "coral open", "it says how to get a link")
	assert.Contains(t, journal.String(), "password")

	journal.Reset()
	assert.False(t, openStartupDashboard(&journal, link, false), "the no-browser start prints the same words")
	assert.NotContains(t, journal.String(), "SECRETTOKEN123")
	journal.Reset()
	openDashboardAtStart(&journal, link)
	assert.NotContains(t, journal.String(), "SECRETTOKEN123", "the start with a browser that did not open prints no token either")

	startupIsTerminal = func() bool { return true }
	var term strings.Builder
	printStartupLink(&term, link)
	assert.Contains(t, term.String(), link, "a terminal gets the link")
	assert.Contains(t, term.String(), "single use, 10 minutes")
}

// `coral open --print` is the person asking for the link: it still prints it.
func TestCoralOpenPrintStillPrintsTheLink(t *testing.T) {
	var out strings.Builder
	openDashboard(&out, "http://localhost:8420/?login_token=abc", false)
	assert.Contains(t, out.String(), "login_token=abc")
}
