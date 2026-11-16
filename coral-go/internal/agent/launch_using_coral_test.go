package agent

import (
	"os"
	"regexp"
	"slices"
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

// #18098: Claude Code does not read systemPrompt from a settings file: the launch carries Coral's text in a file named by --append-system-prompt-file (a file, not argv: Windows limits the line to 32 KB).
func TestClaudeLaunchCarriesTheSystemPromptInAFileFlag(t *testing.T) {
	p := LaunchParams{SessionID: "11111111-2222-3333-4444-555555555556", CoralDir: t.TempDir(), WorkingDir: t.TempDir(), SessionName: "claude-11111111-2222-3333-4444-555555555556", EmbeddedProtocol: true, BoardName: "team-x", Role: "Developer", Prompt: strings.Repeat("a long brief ", 4000)}
	cmd, err := GetAgent("claude").LaunchCommand(p)
	require.NoError(t, err)
	require.Contains(t, cmd, "--append-system-prompt-file ")
	assert.NotContains(t, cmd, "--append-system-prompt ", "the text is not on the command line")
	assert.Less(t, len(cmd), 8000, "the line does not grow with the text")
	m := regexp.MustCompile(`--append-system-prompt-file '?([^' ]+)`).FindStringSubmatch(cmd)
	require.Len(t, m, 2, cmd)
	b, err := os.ReadFile(m[1])
	require.NoError(t, err)
	assert.Contains(t, string(b), "CORAL_SESSION_ID: 11111111-2222-3333-4444-555555555556")
	assert.Contains(t, string(b), "coral-board")
}

// #18151: a print-mode run (a workflow step) names Coral's text with --append-system-prompt-file too, through the real argument path; with no text there is no flag and no file.
func TestPrintArgsCarryTheSystemTextInAFileFlag(t *testing.T) {
	setTestHome(t, t.TempDir())
	sid := "11111111-2222-3333-4444-555555555557"
	args, settings, err := (&ClaudeAgent{}).PrintArgs(LaunchParams{SessionID: sid, WorkingDir: t.TempDir(), EmbeddedProtocol: true, BoardName: "team-x", Role: "Developer"})
	require.NoError(t, err)
	t.Cleanup(func() { os.Remove(settings); os.Remove(PrintSystemFile(settings)) })
	i := slices.Index(args, "--append-system-prompt-file")
	require.GreaterOrEqual(t, i, 0, "%v", args)
	require.Equal(t, PrintSystemFile(settings), args[i+1])
	b, err := os.ReadFile(args[i+1])
	require.NoError(t, err)
	assert.Contains(t, string(b), "CORAL_SESSION_ID: "+sid)
	assert.Contains(t, string(b), "coral-board")
	assert.NotContains(t, args, "--append-system-prompt", "the text is not on the command line")
	// what a workflow step gives: no board, no session, no text
	args, settings, err = (&ClaudeAgent{}).PrintArgs(LaunchParams{WorkingDir: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { os.Remove(settings) })
	assert.NotContains(t, args, "--append-system-prompt-file")
	_, statErr := os.Stat(PrintSystemFile(settings))
	assert.True(t, os.IsNotExist(statErr))
}

// #18151 (QA SHOULD): a resume, a wake and a restart launch line carry the text file too (they are LaunchCommand with ResumeSessionID, the text named by the resumed id).
func TestResumeWakeAndRestartLinesCarryTheSystemTextFile(t *testing.T) {
	sid, old := "11111111-2222-3333-4444-555555555558", "99999999-2222-3333-4444-555555555559"
	for name, p := range map[string]LaunchParams{
		"resume":  {SessionID: sid, ResumeSessionID: old},
		"wake":    {SessionID: sid, ResumeSessionID: old, Prompt: "wake up"},
		"restart": {SessionID: sid, ResumeSessionID: old, Flags: []string{"--model", "sonnet"}},
	} {
		p.CoralDir, p.WorkingDir, p.SessionName = t.TempDir(), t.TempDir(), "claude-"+sid
		p.EmbeddedProtocol, p.BoardName, p.Role = true, "team-x", "Developer"
		cmd, err := GetAgent("claude").LaunchCommand(p)
		require.NoError(t, err, name)
		assert.Contains(t, cmd, "--resume "+old, name)
		m := regexp.MustCompile(`--append-system-prompt-file '?([^' ]+)`).FindStringSubmatch(cmd)
		require.Len(t, m, 2, "%s: %s", name, cmd)
		b, err := os.ReadFile(m[1])
		require.NoError(t, err, name)
		assert.Contains(t, string(b), "CORAL_SESSION_ID: "+sid, name)
	}
}
