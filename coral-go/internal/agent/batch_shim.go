//go:build windows

package agent

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// A CLI installed by npm is a .cmd file on Windows: a small script that runs the real program
// ("%dp0%\node_modules\pkg\bin\cli.exe" %*, or node and a .js file). Started through that file the
// launch line's arguments go through cmd.exe, which reads them again with its own rules (a
// quote ends in the middle of a prompt, < > & | ^ and % act, a line break ends the line, 8191
// characters is the limit), so a prompt cannot be passed that way. The program the file runs
// takes the same arguments and is started directly instead.

// isBatchFile reports whether name is run by cmd.exe: a .cmd or .bat file.
func isBatchFile(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".cmd", ".bat":
		return true
	}
	return false
}

// maxShimBytes is the most of a shim that is read: npm's are under 1 KiB.
const maxShimBytes = 16 << 10

// shimTarget returns the command (the program and the arguments that come before the caller's own)
// that the npm shim whose text is shim, in the folder dir, runs. ok is false when shim is not
// one of npm's shapes, or names anything it cannot be sure of (another variable, a character cmd
// would act on): the caller then does not use it. exists tells whether a file is there;
// lookNode finds node on PATH.
func shimTarget(shim, dir string, exists func(string) bool, lookNode func() (string, bool)) (cmd []string, ok bool) {
	shim = strings.ReplaceAll(shim, "\r", "")
	line := ""
	for _, l := range strings.Split(shim, "\n") {
		if strings.Contains(l, "%*") {
			line = strings.TrimSpace(l) // the last one is the command
		}
	}
	if line == "" {
		return nil, false
	}
	// npm's newer shim runs it after "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ".
	if i := strings.LastIndex(line, " & "); i >= 0 {
		line = line[i+3:]
	}
	i := strings.LastIndex(line, "%*")
	if strings.TrimSpace(line[i+2:]) != "" {
		return nil, false // something after the arguments
	}
	words, ok := shimWords(line[:i])
	if !ok || len(words) == 0 || len(words) > 2 {
		return nil, false
	}
	prog := dir
	if !strings.HasSuffix(prog, `\`) && !strings.HasSuffix(prog, "/") {
		prog += `\`
	}
	for j, w := range words {
		w = expandShimDir(w, prog)
		if w == "%_prog%" {
			if !shimSetsProgToNode(shim) {
				return nil, false
			}
			// SET "_prog=%dp0%\node.exe" if that exists, else node from PATH.
			local := filepath.Join(dir, "node.exe")
			if exists(local) {
				w = local
			} else if n, found := lookNode(); found {
				w = n
			} else {
				return nil, false
			}
		} else if strings.EqualFold(w, "node") || strings.EqualFold(w, "node.exe") {
			if n, found := lookNode(); found {
				w = n
			} else {
				return nil, false
			}
		}
		if strings.ContainsAny(w, "%&|<>^\"\r\n") || w == "" {
			return nil, false
		}
		words[j] = filepath.Clean(w)
	}
	for _, w := range words {
		if !filepath.IsAbs(w) || !exists(w) {
			return nil, false
		}
	}
	switch len(words) {
	case 1: // the program itself
		if strings.EqualFold(filepath.Ext(words[0]), ".exe") {
			return words, true
		}
	case 2: // node and its script
		base := strings.ToLower(filepath.Base(words[0]))
		switch strings.ToLower(filepath.Ext(words[1])) {
		case ".js", ".cjs", ".mjs":
			if base == "node.exe" {
				return words, true
			}
		}
	}
	return nil, false
}

// shimSetsProgToNode reports whether the shim sets _prog, and only to node (its own node.exe or the one on PATH), as npm's does.
func shimSetsProgToNode(shim string) bool {
	found := false
	for _, l := range strings.Split(shim, "\n") {
		l = strings.TrimSpace(l)
		i := strings.Index(strings.ToLower(l), "set ")
		if i < 0 || !strings.Contains(strings.ToLower(l), "_prog=") {
			continue
		}
		v := l[strings.Index(strings.ToLower(l), "_prog=")+len("_prog="):]
		v = strings.TrimSuffix(strings.TrimSpace(v), `"`)
		switch strings.ToLower(v) {
		case "node", `%dp0%\node.exe`, `%~dp0\node.exe`:
			found = true
		default:
			return false // set to anything else somewhere
		}
	}
	return found
}

// expandShimDir writes the shim's own folder (%dp0% or %~dp0) into w.
func expandShimDir(w, dirWithSlash string) string {
	for _, v := range []string{"%dp0%", "%~dp0"} {
		w = strings.ReplaceAll(w, v, strings.TrimSuffix(dirWithSlash, `\`))
	}
	return w
}

// shimWords splits the part of a shim line before %* into its words, a quoted word without its quotes.
func shimWords(s string) ([]string, bool) {
	var words []string
	for i := 0; i < len(s); {
		switch c := s[i]; {
		case c == ' ' || c == '\t':
			i++
		case c == '"':
			j := strings.IndexByte(s[i+1:], '"')
			if j < 0 {
				return nil, false
			}
			words = append(words, s[i+1:i+1+j])
			i += j + 2
		default:
			j := i
			for j < len(s) && s[j] != ' ' && s[j] != '\t' && s[j] != '"' {
				j++
			}
			words = append(words, s[i:j])
			i = j
		}
	}
	return words, true
}

// unwrapBatchShim returns parts with the program, when it is an npm shim, replaced by what the
// shim runs; otherwise parts as they are. The caller's own arguments follow unchanged.
func unwrapBatchShim(parts, raw []string) []string {
	i := programIndex(parts, raw)
	if i < 0 || !isBatchFile(parts[i]) || !filepath.IsAbs(parts[i]) {
		return parts
	}
	f, err := os.Open(parts[i])
	if err != nil {
		return parts
	}
	defer f.Close()
	buf := make([]byte, maxShimBytes+1)
	n, _ := io.ReadFull(f, buf)
	if n > maxShimBytes {
		return parts
	}
	cmd, ok := shimTarget(string(buf[:n]), filepath.Dir(parts[i]), fileExists, func() (string, bool) {
		p, err := exec.LookPath("node.exe")
		return p, err == nil && filepath.IsAbs(p)
	})
	if !ok {
		return parts
	}
	out := append(append([]string{}, parts[:i]...), cmd...)
	return append(out, parts[i+1:]...)
}

// resolveBareProgram returns parts with a program that is a bare name (claude, claude.cmd) replaced by the file PowerShell would run
// for it (PATH and PATHEXT, never the current folder), when that is a .cmd or .bat file: the name alone would reach cmd.exe
// through PowerShell as it is. A program that resolves to an .exe, or to nothing, is left as it was.
func resolveBareProgram(parts, raw []string) []string {
	i := programIndex(parts, raw)
	if i < 0 || strings.ContainsAny(parts[i], `\/:`) {
		return parts
	}
	p, err := exec.LookPath(parts[i])
	if err != nil || !filepath.IsAbs(p) || !isBatchFile(p) {
		return parts
	}
	out := append([]string{}, parts...)
	out[i] = p
	return out
}

// programIndex is where the program is in parts: the first part that is not shell syntax the builder wrote itself (an environment
// prefix), the one joinQuoted starts as the command. -1 when there is none.
func programIndex(parts, raw []string) int {
	isRaw := make(map[string]bool, len(raw))
	for _, r := range raw {
		isRaw[r] = true
	}
	for i, p := range parts {
		if !isRaw[p] {
			return i
		}
	}
	return -1
}

// promptFileMarker starts every prompt argument promptArg makes for PowerShell (FormatPromptFileArg).
const promptFileMarker = `"$(Get-Content -Raw -Encoding UTF8 -LiteralPath `

// withoutPromptForBatch is for a launch whose program is a .cmd or .bat that unwrapBatchShim did not unwrap: cmd.exe would read the
// prompt again with its own rules (it fails or changes it), so the launch goes without it. It returns parts and raw without the
// prompt arguments (and the "--" that stood before one), and the notice the pane shows first; changed is false when parts holds
// no such program or no prompt.
func withoutPromptForBatch(parts, raw []string) (outParts, outRaw []string, notice string, changed bool) {
	prog := programIndex(parts, raw)
	if prog < 0 || !isBatchFile(parts[prog]) {
		return parts, raw, "", false
	}
	isPrompt := func(s string) bool {
		i := strings.Index(s, promptFileMarker)
		return i >= 0 && strings.HasSuffix(s, ")\"")
	}
	// A short prompt of plain characters is read by cmd.exe as it is: it goes on as it always did.
	total, prompts, plain := 0, 0, true
	for i, p := range parts {
		total += len(p) + 1
		if i > prog && isPrompt(p) {
			prompts++
			n, ok := plainPromptFileLen(p)
			total += n
			plain = plain && ok
		}
	}
	if prompts > 0 && plain && total <= maxPlainLineLen {
		return parts, raw, "", false
	}
	for i, p := range parts {
		if i > prog && isPrompt(p) {
			changed = true
			// The option that introduced it goes too, or the next option would be read as its value. These are the options an agent
			// places a prompt after (codex -c, pi --append-system-prompt, agy -i): a new caller of promptArg that puts a prompt after
			// an option must add that option here.
			if n := len(outParts); n > prog+1 && (outParts[n-1] == "-c" || outParts[n-1] == "--append-system-prompt" || outParts[n-1] == "-i") {
				outParts = outParts[:n-1]
			}
			continue
		}
		outParts = append(outParts, p)
	}
	if !changed {
		return parts, raw, "", false
	}
	// A "--" that was left last only separated the prompt from the options.
	if n := len(outParts); n > 1 && outParts[n-1] == "--" {
		outParts = outParts[:n-1]
	}
	for _, r := range raw {
		if !isPrompt(r) {
			outRaw = append(outRaw, r)
		}
	}
	return outParts, outRaw, "Coral: " + filepath.Base(parts[prog]) + " is a .cmd wrapper Coral cannot read, and cmd.exe would change the first message, so this agent was started without it. Point the CLI path at the .exe (or at an npm-installed CLI), or type the first message yourself.", true
}

// maxPlainLineLen is the most the arguments of a .cmd may total (cmd.exe's line is 8191 characters; this leaves a wide margin for what PowerShell adds).
const maxPlainLineLen = 3000

// plainPromptChar reports whether c is one cmd.exe reads as itself inside double quotes (plainPromptFileLen requires the prompt to hold a space, so PowerShell always quotes it): an ASCII letter or digit, a space, or one of the ten marks . , : ; - _ + = / ? (no parenthesis: a wrapper that runs %* inside an IF ( ) block would end the block at a ")").
// Never a quote, backslash, % ^ & | < > ! $ ` ' @ # ~, a line break, any other control character, or a character beyond ASCII.
func plainPromptChar(c rune) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == ' ':
		return true
	}
	return strings.ContainsRune(".,:;-_+=/?", c)
}

// plainPromptFileLen reads the prompt file that the prompt argument arg (the syntax promptArg wrote) names, and returns its length and whether every character is plain (plainPromptChar).
// A file that cannot be read, is empty or is longer than maxPlainLineLen is not plain.
func plainPromptFileLen(arg string) (int, bool) {
	i := strings.Index(arg, promptFileMarker)
	if i < 0 {
		return 0, false
	}
	path := strings.TrimSuffix(arg[i+len(promptFileMarker):], `)"`)
	if len(path) < 2 || path[0] != '\'' || path[len(path)-1] != '\'' {
		return 0, false
	}
	path = strings.ReplaceAll(path[1:len(path)-1], "''", "'")
	f, err := os.Open(path)
	if err != nil {
		return 0, false
	}
	defer f.Close()
	buf := make([]byte, maxPlainLineLen+1)
	n, _ := io.ReadFull(f, buf)
	if n == 0 || n > maxPlainLineLen {
		return n, false
	}
	// At least one space: PowerShell wraps an argument in double quotes only when it holds a space or a tab, and inside quotes these marks are literal to cmd.exe.
	spaced := false
	for _, c := range string(buf[:n]) {
		if !plainPromptChar(c) {
			return n, false
		}
		spaced = spaced || c == ' '
	}
	return n, spaced
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}
