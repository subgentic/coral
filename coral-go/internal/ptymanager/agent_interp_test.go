package ptymanager

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/subgentic/coral/internal/tmux"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestInterpreterName(t *testing.T) {
	for image, want := range map[string]string{
		"/usr/bin/node": "node",
		"/home/u/.nvm/versions/node/v22.1.0/bin/node": "node",
		"/usr/local/bin/node22":                       "node",
		"/usr/local/bin/node-v22.1.0":                 "node",
		"/opt/bun":                                    "bun",
		"/opt/deno":                                   "deno",
		`C:\Program Files\nodejs\node.exe`:            "node",
		"/usr/bin/nodemon":                            "",
		"/usr/bin/nodejs-wrapper":                     "",
		"/usr/bin/python3":                            "",
		"/usr/local/bin/claude":                       "",
		"":                                            "",
	} {
		assert.Equal(t, want, interpreterName(image), image)
	}
}

func TestInterpreterScriptIsExactlyInterpreterThenAbsoluteScript(t *testing.T) {
	abs := filepath.Join(t.TempDir(), "cli.js")
	assert.Equal(t, abs, interpreterScript("/usr/bin/node", []string{"node", abs}))
	assert.Equal(t, abs, interpreterScript("/usr/bin/node", []string{"node", abs, "--resume", "x"}), "arguments after the script are fine")
	assert.Equal(t, "", interpreterScript("/usr/bin/node", []string{"node", "--inspect", abs}), "a flag before the script")
	assert.Equal(t, "", interpreterScript("/usr/bin/node", []string{"node", "cli.js"}), "a relative script: its folder is unknown")
	assert.Equal(t, "", interpreterScript("/usr/bin/node", []string{"node"}), "no script")
	assert.Equal(t, "", interpreterScript("/usr/bin/node", nil), "unreadable arguments")
	assert.Equal(t, "", interpreterScript("/usr/bin/bash", []string{"node", abs}), "the IMAGE decides: a non-interpreter that rewrote its arguments to look like node")
}

func TestShebangInterpreter(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) string {
		p := filepath.Join(dir, name)
		require.NoError(t, os.WriteFile(p, []byte(content), 0o755))
		return p
	}
	assert.Equal(t, "node", shebangInterpreter(write("a", "#!/usr/bin/env node\nconsole.log(1)\n")))
	assert.Equal(t, "node", shebangInterpreter(write("b", "#!/usr/local/bin/node\r\n")))
	assert.Equal(t, "bun", shebangInterpreter(write("c", "#!/usr/bin/env bun\n")))
	assert.Equal(t, "", shebangInterpreter(write("d", "#!/bin/sh\necho\n")))
	assert.Equal(t, "", shebangInterpreter(write("e", "console.log(1)\n")), "no shebang")
	assert.Equal(t, "", shebangInterpreter(write("f", "#!/usr/bin/env -S node --flag\n")), "env with options is unusual: needs the button")
	assert.Equal(t, "", shebangInterpreter(filepath.Join(dir, "missing")))
}

// ScriptIsCLI: the candidate is the resolved CLI run by its interpreter. Each case removes one condition.
func TestScriptIsCLI(t *testing.T) {
	dir := t.TempDir()
	cliReal := filepath.Join(dir, "cli.js")
	require.NoError(t, os.WriteFile(cliReal, []byte("#!/usr/bin/env node\n"), 0o755))
	other := filepath.Join(dir, "other.js")
	require.NoError(t, os.WriteFile(other, []byte("#!/usr/bin/env node\n"), 0o755))
	bunCLI := filepath.Join(dir, "bun-cli.js")
	require.NoError(t, os.WriteFile(bunCLI, []byte("#!/usr/bin/env bun\n"), 0o755))
	plain := filepath.Join(dir, "plain.js")
	require.NoError(t, os.WriteFile(plain, []byte("console.log(1)\n"), 0o755))

	assert.True(t, ScriptIsCLI("/usr/bin/node", cliReal, cliReal), "node running the CLI file")
	link := filepath.Join(dir, "claude")
	if err := os.Symlink(cliReal, link); err == nil { // the npm bin: a symlink to the script
		assert.True(t, ScriptIsCLI("/usr/bin/node", cliReal, link), "the CLI is the bin symlink, node runs its target")
		assert.True(t, ScriptIsCLI("/usr/bin/node", link, cliReal), "node was given the symlink")
	}
	assert.False(t, ScriptIsCLI("/usr/bin/node", other, cliReal), "an interpreter image with another script")
	assert.False(t, ScriptIsCLI("/usr/bin/bash", cliReal, cliReal), "a non-interpreter image whose command line was rewritten to 'node <cli>'")
	assert.False(t, ScriptIsCLI("/usr/bin/bash", plain, plain), "a non-interpreter image and a CLI file without a shebang (both interpreters are \"\")")
	assert.False(t, ScriptIsCLI("/usr/bin/bun", bunCLI, cliReal), "bun's script is not the CLI")
	assert.False(t, ScriptIsCLI("/usr/bin/node", bunCLI, bunCLI), "the CLI's shebang names bun, the image is node")
	assert.False(t, ScriptIsCLI("/usr/bin/node", plain, plain), "the CLI file has no shebang")
	assert.False(t, ScriptIsCLI("/usr/bin/node", filepath.Join(dir, "gone.js"), filepath.Join(dir, "gone.js")), "paths that do not resolve")
	assert.False(t, ScriptIsCLI("/usr/bin/node", "", cliReal), "no script")
	assert.False(t, ScriptIsCLI("/usr/bin/node", cliReal, ""), "no resolved CLI")
	assert.False(t, ScriptIsCLI("/usr/bin/node", filepath.Join(dir, "my"), filepath.Join(dir, "my cli.js")), "the half of a path with a space (macOS ps splits on blanks)")
}

// The program name shown to the Operator (and in the bulk reason) is the image's, not ps's command name: a process can rename itself to look like the agent (perl's $0, prctl).
func TestTheCandidatesProgramNameComesFromTheImageNotTheRenamedComm(t *testing.T) {
	c := fromTmux(tmux.Candidate{AgentProc: tmux.AgentProc{PID: os.Getpid(), Start: "s"}, Program: "node /home/u/claude"}) // what a renamed process reports
	image := tmux.ProgramImage(os.Getpid())
	if image == "" {
		assert.Equal(t, "node /home/u/claude", c.Program, "no image can be read here: ps's name is all there is")
		return
	}
	assert.Equal(t, filepath.Base(image), c.Program)
	assert.Equal(t, image, c.Image)
	assert.NotContains(t, c.Program, "node /home")
}
