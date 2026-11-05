package agent

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/skills"
)

// launchFileRe finds the temp files a launch command names: a Unix path (/tmp/x/coral_settings_y.json) or a Windows one (C:\Users\x\AppData\Local\Temp\coral-agent-1\coral_settings_y.json), quoted or not.
// The Unix-only pattern this replaced found nothing on Windows, so windows-tests saw no instructions at all (#13523, trial-250 gate).
var launchFileRe = regexp.MustCompile(`(?:[A-Za-z]:[\\/]|/)[^\s'"]+?\.(?:json|md|txt)`)

func TestLaunchFileReFindsUnixAndWindowsPaths(t *testing.T) {
	cmd := `export A=1; claude --settings '/tmp/coral-agent-1/coral_settings_x.json' -- "$(cat '/tmp/coral-agent-1/coral_prompt_x.txt')"`
	win := "$env:A='1'; claude --settings 'C:\\Users\\run\\AppData\\Local\\Temp\\coral-agent-1\\coral_settings_x.json' -- (Get-Content -Raw -LiteralPath 'C:\\Users\\run\\AppData\\Local\\Temp\\coral-agent-1\\coral_prompt_x.txt')"
	assert.Equal(t, []string{"/tmp/coral-agent-1/coral_settings_x.json", "/tmp/coral-agent-1/coral_prompt_x.txt"}, launchFileRe.FindAllString(cmd, -1))
	assert.Equal(t, []string{"C:\\Users\\run\\AppData\\Local\\Temp\\coral-agent-1\\coral_settings_x.json", "C:\\Users\\run\\AppData\\Local\\Temp\\coral-agent-1\\coral_prompt_x.txt"}, launchFileRe.FindAllString(win, -1))
}

// launchText is everything a launch hands the CLI as instructions: the command and the temp files it names (the Claude settings file, Codex's developer_instructions file, the prompt files).
func launchText(t *testing.T, typ string, p LaunchParams) string {
	t.Helper()
	p.SessionName = typ + "-11111111-2222-3333-4444-555555555555"
	p.SessionID = "11111111-2222-3333-4444-555555555555"
	p.WorkingDir = t.TempDir()
	p.CoralDir = t.TempDir()
	cmd, err := GetAgent(typ).LaunchCommand(p)
	require.NoError(t, err)
	text := cmd
	for _, m := range launchFileRe.FindAllString(cmd, -1) {
		if b, err := os.ReadFile(m); err == nil {
			text += "\n" + string(b)
		}
	}
	return strings.NewReplacer(`\u003c`, "<", `\u003e`, ">", `\u0026`, "&").Replace(text) // Claude's settings file is JSON: its < > & are escaped there
}

// has is Contains with a short failure message: a launch text is thousands of characters.
func has(t *testing.T, text, want, msg string) {
	t.Helper()
	assert.True(t, strings.Contains(text, want), "missing %q: %s", want, msg)
}

func lacks(t *testing.T, text, unwanted, msg string) {
	t.Helper()
	assert.False(t, strings.Contains(text, unwanted), "unexpected %q: %s", unwanted, msg)
}

// #13523: an agent on no team was told only where the docs are; in a release build a team's agent was told no protocol either (PROTOCOL.md was read from a file the app does not ship). Every agent now carries what
// Coral gives it (the launch region of the using-coral skill), and a team agent carries the protocol compiled into the program.
func TestEveryAgentIsToldWhatCoralGivesIt(t *testing.T) {
	section := skills.LaunchSection()
	require.NotEmpty(t, section)
	for _, typ := range []string{"claude", "codex"} {
		for _, team := range []bool{false, true} {
			p := LaunchParams{}
			if team {
				p.BoardName, p.Role = "team-x", "Developer"
			}
			text := launchText(t, typ, p)
			has(t, text, "coral-agent skills search using-coral", typ+" team="+boolWord(team))
			has(t, text, "coral-agent notify", typ)
			has(t, text, "coral-agent artifact upload", typ)
			has(t, text, DocsPromptLine, typ)
		}
	}
}

func boolWord(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

// With no protocol file (a release build), only an agent on a board gets the compiled-in protocol, and only when the launch says to: a test that names no file sees what it always saw.
func TestATeamAgentCarriesTheCompiledInProtocolWithNoProtocolFile(t *testing.T) {
	const title = "# Coral Agent Protocol"
	for _, typ := range []string{"claude", "codex"} {
		plain := launchText(t, typ, LaunchParams{EmbeddedProtocol: true})
		lacks(t, plain, title, typ+": a plain agent has no use for the orchestrator's manual")
		team := launchText(t, typ, LaunchParams{EmbeddedProtocol: true, BoardName: "team-x", Role: "Developer"})
		has(t, team, title, typ+": a team agent in a release build had no protocol at all")
		off := launchText(t, typ, LaunchParams{BoardName: "team-x", Role: "Developer"})
		lacks(t, off, title, typ+": without the flag (tests, a caller that opted out) nothing is added")
	}
	// a file that reads still wins (a dev build's source tree copy)
	f := t.TempDir() + "/PROTOCOL.md"
	require.NoError(t, os.WriteFile(f, []byte("dev copy of the protocol"), 0o600))
	got := launchText(t, "claude", LaunchParams{EmbeddedProtocol: true, BoardName: "team-x", Role: "Developer", ProtocolPath: f})
	has(t, got, "dev copy of the protocol", "a file that reads wins")
	lacks(t, got, "# Coral Agent Protocol", "the file replaces the compiled-in text, it is not added to it")
}
