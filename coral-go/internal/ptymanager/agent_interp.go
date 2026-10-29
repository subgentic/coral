package ptymanager

import (
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// An npm-installed CLI on Unix runs as `node <script>`: the program's image is node, not the CLI file, so the bulk "record after an update" would leave every such agent to the button. It
// accepts one more signal (#391, for the one-time update of already-running agents, bulk only, never notices): the process's IMAGE is an interpreter (node, bun, deno; a version suffix
// allowed), its argument vector is exactly [interpreter, script, ...args] with no flag before the script, the script is an absolute path whose realpath is the resolved CLI file's realpath,
// and the CLI file's own shebang names that same interpreter. The arguments are compared and dropped. Anything else (a flag first, a relative path, an unreadable line, a space in the path on
// macOS, another script, another interpreter) needs the button.
//// On macOS the image comes from `ps comm`, which follows argv[0] (`exec -a node`): there this rule is a convenience for the one-time update of already-running agents, not a check that// holds against a program built to imitate the agent. Linux's /proc/<pid>/exe cannot be rewritten by the process, so there it is a check.

var interpreterRe = regexp.MustCompile(`^(node|bun|deno)([-_.]?v?[0-9][0-9.]*)?$`)

// interpreterName is node, bun or deno when image is one of them (by the image's base name, a version suffix allowed), else "".
func interpreterName(image string) string {
	base := strings.TrimSuffix(strings.ToLower(filepath.Base(strings.ReplaceAll(image, "\\", "/"))), ".exe")
	if m := interpreterRe.FindStringSubmatch(base); m != nil {
		return m[1]
	}
	return ""
}

// interpreterScript is the script argument of [interpreter, script, ...args]: args[1], when it is an absolute path that does not start like a flag. "" otherwise.
func interpreterScript(image string, args []string) string {
	if interpreterName(image) == "" || len(args) < 2 || !filepath.IsAbs(args[1]) {
		return ""
	}
	return args[1]
}

// shebangInterpreter is the interpreter the file's first line names (`#!/usr/bin/env node` or `#!/usr/bin/node`), or "" when the file has none, is unreadable, or the line is unusual.
func shebangInterpreter(file string) string {
	f, err := os.Open(file)
	if err != nil {
		return ""
	}
	defer f.Close()
	buf := make([]byte, 256)
	n, _ := io.ReadFull(f, buf)
	line := string(buf[:n])
	if !strings.HasPrefix(line, "#!") {
		return ""
	}
	if i := strings.IndexAny(line, "\r\n"); i >= 0 {
		line = line[:i]
	} else if n == len(buf) {
		return "" // a first line longer than the buffer
	}
	fields := strings.Fields(line[2:])
	if len(fields) == 0 {
		return ""
	}
	prog := fields[0]
	if filepath.Base(prog) == "env" {
		if len(fields) < 2 || strings.HasPrefix(fields[1], "-") {
			return ""
		}
		prog = fields[1]
	}
	return interpreterName(prog)
}

// ScriptIsCLI is whether the candidate is the resolved CLI run by its interpreter: image is node/bun/deno, script (its argument, from interpreterScript) and cli are the same file by realpath,
// and cli's shebang names that interpreter. Unresolvable paths are never the same.
func ScriptIsCLI(image, script, cli string) bool {
	interp := interpreterName(image)
	if interp == "" || script == "" || cli == "" {
		return false
	}
	a, errA := filepath.EvalSymlinks(script)
	b, errB := filepath.EvalSymlinks(cli)
	if errA != nil || errB != nil || filepath.Clean(a) != filepath.Clean(b) {
		return false
	}
	return shebangInterpreter(b) == interp
}
