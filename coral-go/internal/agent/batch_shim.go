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
func unwrapBatchShim(parts []string) []string {
	if len(parts) == 0 || !isBatchFile(parts[0]) || !filepath.IsAbs(parts[0]) {
		return parts
	}
	f, err := os.Open(parts[0])
	if err != nil {
		return parts
	}
	defer f.Close()
	buf := make([]byte, maxShimBytes+1)
	n, _ := io.ReadFull(f, buf)
	if n > maxShimBytes {
		return parts
	}
	cmd, ok := shimTarget(string(buf[:n]), filepath.Dir(parts[0]), fileExists, func() (string, bool) {
		p, err := exec.LookPath("node.exe")
		return p, err == nil && filepath.IsAbs(p)
	})
	if !ok {
		return parts
	}
	return append(append([]string{}, cmd...), parts[1:]...)
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}
