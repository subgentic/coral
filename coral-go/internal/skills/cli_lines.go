package skills

import (
	"io/fs"
	"regexp"
	"strings"
)

// StarterText is the SKILL.md text of a starter skill ("" when there is none of that name).
func StarterText(name string) string {
	b, err := fs.ReadFile(starterFS, "starter/"+name+"/SKILL.md")
	if err != nil {
		return ""
	}
	return string(b)
}

var (
	cliInlineRe = regexp.MustCompile("`(coral-(?:agent|board) [^`]+)`")
	flagSpanRe  = regexp.MustCompile("`(--[a-z][a-z-]*)(?: [^`]*)?`")
	cliTrailer  = regexp.MustCompile(`\s+#\s.*$`)
)

// CLILines are the coral-agent and coral-board command lines a skill's Markdown shows (a code block's lines that begin with one of them, and such a command in an inline code span), for the tests that
// check each line's options against the real commands (#13943): the no-invented-flags rule of the skills Coral ships. A trailing "# comment" is dropped.
func CLILines(md string) []string {
	var out []string
	inFence := false
	for _, line := range strings.Split(md, "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "```") {
			inFence = !inFence
			continue
		}
		if inFence {
			if strings.HasPrefix(t, "coral-agent ") || strings.HasPrefix(t, "coral-board ") {
				out = append(out, cliTrailer.ReplaceAllString(t, ""))
			}
			continue
		}
		for _, m := range cliInlineRe.FindAllStringSubmatch(line, -1) {
			out = append(out, m[1])
		}
	}
	return out
}

// FlagSpans are the options a skill names on their own in an inline code span ("--type T"): their names, with the dashes.
func FlagSpans(md string) []string {
	var out []string
	inFence := false
	for _, line := range strings.Split(md, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		for _, m := range flagSpanRe.FindAllStringSubmatch(line, -1) {
			out = append(out, m[1])
		}
	}
	return out
}

// SplitCommand splits a command line into its words the way a shell does for the quoting a skill uses: spaces separate words, and single or double quotes group one (the quotes are dropped).
func SplitCommand(line string) []string {
	var out []string
	var cur strings.Builder
	var quote rune
	started := false
	angle := 0 // inside a <placeholder> a space does not end the word
	for _, r := range line {
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
		case r == '"' || r == '\'':
			quote, started = r, true
		case r == '<':
			angle++
			cur.WriteRune(r)
			started = true
		case r == '>' && angle > 0:
			angle--
			cur.WriteRune(r)
		case (r == ' ' || r == '\t') && angle == 0:
			if started || cur.Len() > 0 {
				out = append(out, cur.String())
				cur.Reset()
				started = false
			}
		default:
			cur.WriteRune(r)
			started = true
		}
	}
	if started || cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}

// RunnableArgs turns a command line of a skill into arguments that can be run in a test: a <placeholder> or a $VARIABLE becomes "x", and the example folder becomes dir.
func RunnableArgs(line, dir string) []string {
	words := SplitCommand(line)
	if len(words) > 0 {
		words = words[1:] // the command's own name
	}
	for i, w := range words {
		switch {
		case w == "/path/to/folder":
			words[i] = dir
		case strings.HasPrefix(w, "$") || (strings.HasPrefix(w, "<") && strings.HasSuffix(w, ">")):
			words[i] = "x"
		}
	}
	return words
}
