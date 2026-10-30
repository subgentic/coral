// Package shellkill finds the shell commands that stop processes by a name or a pattern (pkill, killall, a kill fed by pgrep) in the command line an agent is about to run (#11157).
//
// Why they are refused: a pattern is matched against the WHOLE command line of every process of the user, and an agent's own command line holds the prompt it was launched with. One
// `pkill -f "go test ./..."` ended three other agents whose prompts quote that text, in the same second, with nothing in any log. What an agent may stop is what it started: `kill <pid>`
// of the pid it was given (cmd & pid=$!), `kill %1`, or a job under `timeout`.
//
// The command is read as a shell reads it, to the extent that matters here: a word is the program only in command position (the start, after ; & | && || ( newline, $( and a backquote, and after
// a prefix such as sudo, env, nohup, time, timeout, nice or command), so the word pkill in a commit message, a heredoc, a quoted argument, grep or echo is not a command.
package shellkill

import "strings"

// Reason is why the command is refused, or "" when it stops nothing by a pattern. It never refuses `kill <pid>`, `kill %1`, `kill -9 "$pid"`, `pkill` written inside a quote or a here-document.
func PatternKill(command string) string {
	for _, c := range commands(command) {
		if why := judge(c); why != "" {
			return why
		}
	}
	return ""
}

// Message is what the agent is told when the command is refused: the reason and what to do instead.
func Message(why string) string {
	return "Coral refused this command: " + why + ". A pattern is matched against the whole command line of every process, and every agent's command line holds its launch prompt, so it can end other agents' CLIs without a word (#11157). " +
		"Stop only what you started: run it in the background and keep its pid (cmd & pid=$!; kill \"$pid\"), use kill %1, or run it under timeout. Ask the person before ending a process you did not start. " +
		"(The Operator can turn this check off with the refuse_pattern_kill setting.)"
}

type cmd struct {
	words []string // the simple command's words with quoting removed
	subst []string // the text of every $( ) and `` ` `` inside its words, which a shell runs as commands
}

// commands splits the text into simple commands (and the commands inside $( ) and backquotes).
func commands(src string) []cmd {
	var out []cmd
	var walk func(s string)
	walk = func(s string) {
		var cur cmd
		var word strings.Builder
		inWord := false
		flushWord := func() {
			if inWord {
				cur.words = append(cur.words, word.String())
			}
			word.Reset()
			inWord = false
		}
		endCmd := func() {
			flushWord()
			if len(cur.words) > 0 || len(cur.subst) > 0 {
				out = append(out, cur)
			}
			cur = cmd{}
		}
		var heredocs []string // delimiters waiting for the end of this line
		i := 0
		for i < len(s) {
			ch := s[i]
			switch {
			case ch == '\n':
				endCmd()
				i++
				for len(heredocs) > 0 { // the bodies follow: skipped to their delimiter lines
					delim := heredocs[0]
					heredocs = heredocs[1:]
					for i < len(s) {
						j := strings.IndexByte(s[i:], '\n')
						line := s[i:]
						if j >= 0 {
							line = s[i : i+j]
						}
						i += len(line)
						if j >= 0 {
							i++
						}
						if strings.TrimLeft(line, "\t") == delim {
							break
						}
					}
				}
			case ch == ' ' || ch == '\t' || ch == '\r':
				flushWord()
				i++
			case ch == '#' && !inWord:
				for i < len(s) && s[i] != '\n' {
					i++
				}
			case ch == ';' || ch == '|' || ch == '&' || ch == '(' || ch == ')' || ch == '{' && !inWord || ch == '}' && !inWord:
				endCmd()
				i++
			case ch == '<' && strings.HasPrefix(s[i:], "<<") && !strings.HasPrefix(s[i:], "<<<"):
				i += 2
				if i < len(s) && s[i] == '-' {
					i++
				}
				for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
					i++
				}
				var d strings.Builder
				for i < len(s) && s[i] != ' ' && s[i] != '\t' && s[i] != '\n' && s[i] != ';' && s[i] != '|' && s[i] != '&' && s[i] != ')' {
					if s[i] != '\'' && s[i] != '"' && s[i] != '\\' {
						d.WriteByte(s[i])
					}
					i++
				}
				if d.Len() > 0 {
					heredocs = append(heredocs, d.String())
				}
			case ch == '\'':
				inWord = true
				i++
				for i < len(s) && s[i] != '\'' {
					word.WriteByte(s[i])
					i++
				}
				i++
			case ch == '"':
				inWord = true
				i++
				for i < len(s) && s[i] != '"' {
					switch {
					case s[i] == '\\' && i+1 < len(s):
						word.WriteByte(s[i+1])
						i += 2
					case s[i] == '$' && i+1 < len(s) && s[i+1] == '(':
						body, n := balanced(s[i+2:])
						cur.subst = append(cur.subst, body)
						word.WriteString("$(…)")
						i += 2 + n
					case s[i] == '`':
						j := strings.IndexByte(s[i+1:], '`')
						if j < 0 {
							j = len(s) - i - 1
						}
						cur.subst = append(cur.subst, s[i+1:i+1+j])
						word.WriteString("`…`")
						i += j + 2
					default:
						word.WriteByte(s[i])
						i++
					}
				}
				i++
			case ch == '\\' && i+1 < len(s):
				inWord = true
				word.WriteByte(s[i+1])
				i += 2
			case ch == '$' && i+1 < len(s) && s[i+1] == '(':
				inWord = true
				body, n := balanced(s[i+2:])
				cur.subst = append(cur.subst, body)
				word.WriteString("$(…)")
				i += 2 + n
			case ch == '`':
				inWord = true
				j := strings.IndexByte(s[i+1:], '`')
				if j < 0 {
					j = len(s) - i - 1
				}
				cur.subst = append(cur.subst, s[i+1:i+1+j])
				word.WriteString("`…`")
				i += j + 2
			default:
				inWord = true
				word.WriteByte(ch)
				i++
			}
		}
		endCmd()
	}
	walk(src)
	// The commands inside substitutions are commands too.
	for i := 0; i < len(out); i++ {
		for _, sub := range out[i].subst {
			var inner []cmd
			inner = append(inner, commands(sub)...)
			out = append(out, inner...)
		}
		out[i].subst = out[i].subst[:len(out[i].subst):len(out[i].subst)]
	}
	return out
}

// balanced returns the text up to the ) that closes a $( and how many bytes it took with that ).
func balanced(s string) (string, int) {
	depth := 1
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return s[:i], i + 1
			}
		}
	}
	return s, len(s)
}

// prefixes are words that run the next word as a program: the program after them is the command.
var prefixes = map[string]bool{"sudo": true, "command": true, "exec": true, "nohup": true, "env": true, "time": true, "nice": true, "timeout": true, "builtin": true, "stdbuf": true, "setsid": true, "doas": true}

func judge(c cmd) string {
	i := 0
	// leading VAR=value assignments and prefix words (with their own options and numbers)
	for i < len(c.words) {
		w := c.words[i]
		if strings.Contains(w, "=") && !strings.HasPrefix(w, "=") && !strings.ContainsAny(strings.SplitN(w, "=", 2)[0], "/ ") {
			i++
			continue
		}
		if prefixes[base(w)] {
			i++
			for i < len(c.words) && (strings.HasPrefix(c.words[i], "-") || isNumber(c.words[i]) || strings.Contains(c.words[i], "=")) {
				i++
			}
			continue
		}
		break
	}
	if i >= len(c.words) {
		return ""
	}
	prog := base(c.words[i])
	args := c.words[i+1:]
	switch prog {
	case "pkill":
		return "pkill stops processes by a name or a pattern"
	case "killall", "killall5":
		return "killall stops processes by a name"
	case "xargs":
		for _, a := range args {
			switch base(a) {
			case "kill", "pkill", "killall":
				return "xargs kill stops whatever a search found"
			}
		}
	case "kill":
		for _, a := range args {
			if strings.Contains(a, "$(…)") || strings.Contains(a, "`…`") {
				for _, sub := range c.subst {
					if searches(sub) {
						return "kill of the output of pgrep, pidof or ps stops whatever a search found"
					}
				}
			}
		}
	}
	return ""
}

// searches is whether a command text looks processes up by name (what a kill must not be fed).
func searches(sub string) bool {
	for _, c := range commands(sub) {
		for i, w := range c.words {
			switch base(w) {
			case "pgrep", "pidof":
				return true
			case "ps":
				_ = i
				return true
			}
			break
		}
	}
	return false
}

func base(w string) string {
	if i := strings.LastIndexByte(w, '/'); i >= 0 {
		return w[i+1:]
	}
	return w
}

func isNumber(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if (r < '0' || r > '9') && r != '.' && r != 's' && r != 'm' && r != 'h' {
			return false
		}
	}
	return true
}
