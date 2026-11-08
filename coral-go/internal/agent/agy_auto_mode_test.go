package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14741 (the Operator: every agent starts in auto where its CLI has one; Security's rulings (a) and (b)): agy 1.5.3 has --mode auto. Antigravity, Gemini (agy itself) and agy launch in it by default, ONLY when that
// agy's own --help lists it (an older one asks, and never takes a skip flag in its place); and no launch that only took the default ever carries a skip flag: only Bypass or Keep Full access does.

const agyHelpWithAuto = `Usage of agy:
  --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting
  --mode                          Set the agent execution mode for this session (accept-edits, auto, plan)
  --model                         Model for the current CLI session
`
const agyHelpWithoutAuto = `Usage of agy:
  --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting
  --mode                          Set the agent execution mode for this session (accept-edits, plan)
`

func withAgyHelp(t *testing.T, help string) {
	t.Helper()
	old := cliHelp
	cliHelp = func(string) string { return help }
	agyAutoModeCache.Range(func(k, _ any) bool { agyAutoModeCache.Delete(k); return true })
	t.Cleanup(func() {
		cliHelp = old
		agyAutoModeCache.Range(func(k, _ any) bool { agyAutoModeCache.Delete(k); return true })
	})
}

func TestTheShippedDefaultOfTheAgyTypesIsAuto(t *testing.T) {
	for _, typ := range []string{"agy", "antigravity", "gemini", "claude", "codex"} {
		assert.Equal(t, "auto", DefaultLaunchPermissionMode(typ), typ)
	}
	assert.Equal(t, "bypassPermissions", DefaultLaunchPermissionMode("hermes"), "Hermes keeps its named bypass default (#14333); auto is never mapped to --yolo")
	assert.Equal(t, "bypassPermissions", DefaultLaunchPermissionMode("opencode"))
}

func TestAgyHelpListsAutoOnlyAsAValueOfMode(t *testing.T) {
	assert.True(t, agyHelpListsAutoMode(agyHelpWithAuto))
	assert.False(t, agyHelpListsAutoMode(agyHelpWithoutAuto))
	assert.False(t, agyHelpListsAutoMode("  --mode  Set the mode (accept-edits, plan)\n  --auto-approve  yes\n"), "another flag with auto in its name is not the value")
	assert.False(t, agyHelpListsAutoMode("  --dangerously-skip-permissions  Auto-approve all tool permission requests\n"), "the skip flag's words are not a mode")
	// QA Reviewer 2's SHOULD on #14741: '--auto-approve' pinned. A flag of that name, on its own line or in the --mode line's own description, is not the value auto.
	assert.False(t, agyHelpListsAutoMode("  --auto-approve  Approve every tool call\n  --mode  Set the mode (accept-edits, plan)\n"), "--auto-approve on a line of its own")
	assert.False(t, agyHelpListsAutoMode("  --mode  Set the mode (accept-edits, plan); see also --auto-approve\n"), "--auto-approve named inside the --mode description")
	assert.False(t, agyHelpListsAutoMode("  --mode  Set the mode (accept-edits, plan) (auto-approve is separate)\n"), "auto-approve is not auto")
	assert.False(t, agyHelpListsAutoMode(""), "a help that could not be read is no")
	assert.True(t, agyHelpListsAutoMode("  --mode string  mode: auto|plan|accept-edits\n"), "another list form")
}

func TestAnAgyThatListsAutoLaunchesInAutoAndNeverWithASkipFlag(t *testing.T) {
	withAgyHelp(t, agyHelpWithAuto)
	full := &Capabilities{Allow: []string{CapShell, CapFileWrite}}
	for name, p := range map[string]LaunchParams{
		"a launch that names auto":                      {PermissionMode: "auto"},
		"auto with full capabilities (agy's yolo list)": {PermissionMode: "auto", Capabilities: full},
		"auto with a stored --permission-mode auto":     {Flags: []string{"--permission-mode", "auto"}},
		"auto with the old --approval-mode":             {PermissionMode: "auto", Flags: []string{"--model", "x"}},
		"a resume that stored auto":                     {PermissionMode: "auto", ResumeSessionID: "conv-1"},
		"a wake or restart of a stored auto, full caps": {PermissionMode: "auto", ResumeSessionID: "conv-2", Capabilities: full},
	} {
		cmd := buildLaunch(&AgyAgent{}, p)
		assert.Contains(t, cmd, "--mode auto", name)
		assert.NotContains(t, cmd, "--dangerously-skip-permissions", name+": auto is never the skip flag")
		assert.NotContains(t, cmd, "--yolo", name)
	}
}

func TestAnAgyThatDoesNotListAutoAsksAndTakesNoSkipFlagInItsPlace(t *testing.T) {
	withAgyHelp(t, agyHelpWithoutAuto)
	full := &Capabilities{Allow: []string{CapShell, CapFileWrite}}
	for name, p := range map[string]LaunchParams{
		"a launch that names auto":    {PermissionMode: "auto"},
		"auto with full capabilities": {PermissionMode: "auto", Capabilities: full},
		"a stored --permission-mode":  {Flags: []string{"--permission-mode", "auto"}},
		"a resume that stored auto":   {PermissionMode: "auto", ResumeSessionID: "conv-1"},
	} {
		cmd := buildLaunch(&AgyAgent{}, p)
		assert.NotContains(t, cmd, "--mode auto", name)
		assert.NotContains(t, cmd, "--dangerously-skip-permissions", name+": no skip flag in auto's place")
	}
}

// The hard rule (Security, #14741 point 2): a skip flag comes only from Bypass, the Operator's Keep Full access, or a flag the person or the stored settings carry; never from a mode that only took the default,
// whatever the capabilities say.
func TestNoAgyLaunchThatOnlyTookTheDefaultCarriesASkipFlag(t *testing.T) {
	for _, help := range []string{agyHelpWithAuto, agyHelpWithoutAuto} {
		withAgyHelp(t, help)
		full := &Capabilities{Allow: []string{CapShell, CapFileWrite}}
		for _, typ := range []string{"agy", "antigravity", "gemini"} {
			def := DefaultLaunchPermissionMode(typ)
			for name, caps := range map[string]*Capabilities{"no capabilities": nil, "full capabilities": full, "a writer list": {Allow: []string{CapFileRead, CapFileWrite}}} {
				cmd := buildLaunch(&AgyAgent{}, LaunchParams{PermissionMode: def, Capabilities: caps})
				assert.NotContains(t, cmd, "--dangerously-skip-permissions", typ+" default with "+name)
			}
		}
		assert.Contains(t, buildLaunch(&AgyAgent{}, LaunchParams{PermissionMode: "bypassPermissions"}), "--dangerously-skip-permissions", "Bypass still does")
		assert.Contains(t, buildLaunch(&AgyAgent{}, LaunchParams{PermissionMode: "auto", KeepFullAccess: true}), "--dangerously-skip-permissions", "Keep Full access still does")
	}
}

func TestAgyLaunchModeSaysAutoAndAgreesWithTheBuilder(t *testing.T) {
	withAgyHelp(t, agyHelpWithAuto)
	full := &Capabilities{Allow: []string{CapShell, CapFileWrite}}
	assert.Equal(t, "auto", AgyLaunchMode(nil, nil, "auto", false))
	assert.Equal(t, "auto", AgyLaunchMode(nil, full, "auto", false), "full capabilities under a named auto stay auto")
	assert.Equal(t, "auto", AgyLaunchMode([]string{"--mode", "auto"}, nil, "", false))
	assert.Equal(t, "skip", AgyLaunchMode(nil, full, "", false), "full capabilities with NO mode named are still agy's yolo (as before)")
	assert.True(t, strings.Contains(buildLaunch(&AgyAgent{}, LaunchParams{PermissionMode: "auto", Capabilities: full}), "--mode auto"))
}

// QA Reviewer 2's SHOULD on #14741: the cache is per FILE (path, size and modification time), so an agy updated in place is asked again. With the stat part of the key turned off this fails: the first answer would
// be kept for the path whatever the file became.
func TestTheAutoModeAnswerIsKeptPerFileNotPerPath(t *testing.T) {
	old := cliHelp
	cliHelp = func(p string) string { b, _ := os.ReadFile(p); return string(b) } // the "help" of this stand-in agy is its own content
	agyAutoModeCache.Range(func(k, _ any) bool { agyAutoModeCache.Delete(k); return true })
	t.Cleanup(func() {
		cliHelp = old
		agyAutoModeCache.Range(func(k, _ any) bool { agyAutoModeCache.Delete(k); return true })
	})
	p := filepath.Join(t.TempDir(), "agy")
	require.NoError(t, os.WriteFile(p, []byte(agyHelpWithoutAuto), 0o755))
	assert.False(t, AgySupportsAutoMode(p), "an agy that does not list auto")
	assert.False(t, AgySupportsAutoMode(p), "asked again: the same answer from the cache")
	// the file is replaced by a newer agy at the same path (a different size, and a later time)
	require.NoError(t, os.WriteFile(p, []byte(agyHelpWithAuto), 0o755))
	later := time.Now().Add(time.Hour)
	require.NoError(t, os.Chtimes(p, later, later))
	assert.True(t, AgySupportsAutoMode(p), "the updated file is asked again, not answered from the old file's entry")
}
