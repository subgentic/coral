// Package shellkill finds the shell commands that stop processes by a name or a pattern (pkill, killall, a kill fed by pgrep) in the command line an agent is about to run (#11157).
//
// Why they are refused: a pattern is matched against the WHOLE command line of every process of the user, and an agent's own command line holds the prompt it was launched with. One
// `pkill -f "go test ./..."` ended three other agents whose prompts quote that text, in the same second, with nothing in any log. What an agent may stop is what it started: `kill <pid>`
// of the pid it was given (cmd & pid=$!), `kill %1`, or a job under `timeout`.
//
// The command is read as a shell reads it, to the extent that matters here: a word is the program only in command position (the start, after ; & | && || ( newline, $( and a backquote, and after
// a prefix such as sudo, env, nohup, time, timeout, nice or command), so the word pkill in a commit message, a heredoc, a quoted argument, grep or echo is not a command.
package shellkill

import (
	"regexp"
	"strings"
	"time"
)

// Bounds (Security's #11157 MUST): the command comes from an agent, and a prompt-injected one must not make the server work for it. Past any of them the command is LET RUN (""): this is a guard against
// an accident, not a sandbox.
const (
	maxBytes    = 64 << 10 // a longer command is not read
	maxDepth    = 8        // substitutions and bash -c / eval inside each other
	maxCommands = 2000     // simple commands read
)

// maxWork is the time the reading may take. A variable so that a test can make the bound short enough to pass.
var maxWork = 20 * time.Millisecond

// Reason is why the command is refused, or "" when it stops nothing by a pattern. It never refuses `kill <pid>`, `kill %1`, `kill -9 "$pid"`, `pkill` written inside a quote or a here-document.
func PatternKill(command string) string {
	cmds, ok := commands(command)
	if !ok {
		return "" // past a bound: it runs
	}
	for _, c := range cmds {
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

// parseOne splits one text into its simple commands, once: what is inside $( ) and backquotes is kept as text on the command (cmd.subst) for the caller to read in its turn, so every text is read
// once and the work is linear in the depth (it was exponential before: each level was read twice). It reports false when the time is up.
func parseOne(s string, p *reader) ([]cmd, bool) {
	var out []cmd
	{
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
			if p.tick() {
				return nil, false
			}
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
	return out, !p.over
}

// reader holds what one reading may spend: its start, the commands read so far and whether a bound was passed.
type reader struct {
	start time.Time
	steps int
	cmds  int
	over  bool
}

// tick is called once per character: the clock is looked at every 512, and true means a bound was passed.
func (p *reader) tick() bool {
	p.steps++
	if p.steps&511 == 0 && time.Since(p.start) > maxWork {
		p.over = true
	}
	return p.over
}

// commands reads src and everything inside it that a shell runs as a command: substitutions, and the script of a bash -c or eval, each once, to a depth of maxDepth. ok is false when a bound was
// passed (the size, the depth, the number of commands, the time): the caller lets the command run.
func commands(src string) (all []cmd, ok bool) {
	if len(src) > maxBytes {
		return nil, false
	}
	p := &reader{start: time.Now()}
	type item struct {
		text  string
		depth int
	}
	queue := []item{{src, 0}}
	for len(queue) > 0 {
		it := queue[0]
		queue = queue[1:]
		cs, ok := parseOne(it.text, p)
		if !ok {
			return nil, false
		}
		for _, c := range cs {
			p.cmds++
			if p.cmds > maxCommands {
				return nil, false
			}
			all = append(all, c)
			subs := append([]string(nil), c.subst...)
			subs = append(subs, scriptsOf(c)...)
			if len(subs) > 0 && it.depth+1 > maxDepth {
				return nil, false
			}
			for _, sub := range subs {
				queue = append(queue, item{sub, it.depth + 1})
			}
		}
	}
	return all, true
}

// shells are the programs whose -c argument is a script, read one level in its turn.
var shells = map[string]bool{"bash": true, "sh": true, "zsh": true, "dash": true, "ksh": true}

// scriptsOf is the text a command hands to a shell to run: the argument after -c (or a flag cluster ending in c, -lc) of bash, sh, zsh, dash and ksh, and what eval is given.
func scriptsOf(c cmd) []string {
	i := programIndex(c)
	if i < 0 {
		return nil
	}
	prog, args := base(c.words[i]), c.words[i+1:]
	switch {
	case prog == "eval":
		if len(args) > 0 {
			return []string{strings.Join(args, " ")}
		}
	case shells[prog]:
		for j, a := range args {
			if strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "--") && strings.HasSuffix(a, "c") && j+1 < len(args) {
				return []string{args[j+1]}
			}
		}
	}
	return nil
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
var prefixes = map[string]bool{"sudo": true, "command": true, "exec": true, "nohup": true, "env": true, "time": true, "nice": true, "timeout": true, "builtin": true, "stdbuf": true, "setsid": true, "ionice": true, "chrt": true, "doas": true}

// wrapperOptionValues are, for the wrappers, the options (short and long, as the separate word that names them) whose value is the next word.
var wrapperOptionValues = map[string]map[string]bool{
	"sudo":    set("-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-D", "--chdir", "-R", "--chroot", "-r", "--role", "-t", "--type", "-U", "--other-user", "-T", "--command-timeout"),
	"doas":    set("-u", "-C"),
	"env":     set("-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-a", "--argv0"),
	"timeout": set("-s", "--signal", "-k", "--kill-after"),
	"ionice":  set("-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"),
	"nice":    set("-n", "--adjustment"),
	"chrt":    set("-p", "--pid"),
	"stdbuf":  set("-i", "--input", "-o", "--output", "-e", "--error"),
}

// optionTakesNextWord is whether the option word w of a wrapper is followed by its value as the next word: a listed option by itself (-u, --user), or a cluster of short options whose last letter takes a
// value ("sudo -nu root", "sudo -Eu root"); a value attached in the cluster ("-uroot", "-nuroot") is not another word.
func optionTakesNextWord(wrapper, w string) bool {
	opts := wrapperOptionValues[wrapper]
	if opts[w] {
		return true
	}
	if len(w) < 3 || w[0] != '-' || w[1] == '-' {
		return false
	}
	for i := 1; i < len(w); i++ {
		if opts["-"+string(w[i])] {
			return i == len(w)-1 // the letter ends the cluster: its value is the next word; else the rest of the cluster is its value
		}
	}
	return false
}

func set(words ...string) map[string]bool {
	m := make(map[string]bool, len(words))
	for _, w := range words {
		m[w] = true
	}
	return m
}

// keywords start a command the way ; does: what follows then, do, else, if, elif, while, until and ! is in command position ("if true; then pkill x; fi").
var keywords = map[string]bool{"if": true, "then": true, "else": true, "elif": true, "do": true, "while": true, "until": true, "!": true, "{": true}

// programIndex is where the program is among a command's words: after VAR=value assignments, keywords and prefix words (sudo, env, timeout 5, ...) with their own options and numbers; -1 when
// there is none.
func programIndex(c cmd) int {
	i := 0
	for i < len(c.words) {
		w := c.words[i]
		if strings.Contains(w, "=") && !strings.HasPrefix(w, "=") && !strings.ContainsAny(strings.SplitN(w, "=", 2)[0], "/ ") {
			i++
			continue
		}
		if keywords[w] {
			i++
			continue
		}
		if prefixes[base(w)] {
			wrapper := base(w)
			i++
			for i < len(c.words) && (strings.HasPrefix(c.words[i], "-") || isNumber(c.words[i]) || strings.Contains(c.words[i], "=")) {
				// An option that takes its own value ("sudo -u root", "env -u NAME", "timeout -s KILL 10", "ionice -c 3") eats the next word: it is not the program (QA's #11179).
				takes := optionTakesNextWord(wrapper, c.words[i])
				i++
				if takes && i < len(c.words) {
					i++
				}
			}
			continue
		}
		break
	}
	if i >= len(c.words) {
		return -1
	}
	return i
}

func judge(c cmd) string {
	i := programIndex(c)
	if i < 0 {
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
		if why := killsEverything(args); why != "" {
			return why
		}
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
	cs, ok := parseOne(sub, &reader{start: time.Now()})
	if !ok {
		return false
	}
	for _, c := range cs {
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

// durationRe is a number a wrapper takes: timeout's duration (10, 1.5, .5, 5., 30s, 5.s, 5m, 2h, 1d) and nice's adjustment. It needs a digit: a word of letters like "sh" or "mh" is a program, not a duration.
var durationRe = regexp.MustCompile(`^([0-9]+(\.[0-9]*)?|\.[0-9]+)[smhd]?$`)

func isNumber(s string) bool { return durationRe.MatchString(s) }

// killsEverything is why a kill signals more than the process it names (Security's #11157 INFOs): -1 signals every process the user can reach and 0 the whole process group, which in an agent's shell
// holds Coral's own tmux panes and the other agents; a negative number is a process group. "kill 1234", "kill %1", "kill $pid" and "kill -9 1234" are not it.
func killsEverything(args []string) string {
	i, signal := 0, ""
	var targets []string
	afterDashes := false
	for i < len(args) {
		a := args[i]
		switch {
		case a == "--" && !afterDashes:
			afterDashes = true
		case !afterDashes && len(targets) == 0 && signal == "" && (a == "-s" || a == "-n" || a == "--signal"):
			signal = a
			i++ // its value is the signal
			if i < len(args) {
				signal = args[i]
			}
		case !afterDashes && len(targets) == 0 && signal == "" && signalSpec(a):
			signal = a
		default:
			targets = append(targets, a)
		}
		i++
	}
	const why = "kill of -1, 0 or a process group signals every process the user owns or the whole group, Coral's own and the other agents' included"
	if len(targets) == 0 && signal == "-1" {
		return why // "kill -1": every process, as written in the one place it was asked for
	}
	for _, t := range targets {
		if t == "0" || t == "-0" || (len(t) > 1 && t[0] == '-' && (t[1] >= '0' && t[1] <= '9' || t[1] == '$')) {
			return why
		}
	}
	return ""
}

// signalSpec is a kill option naming a signal: -9, -KILL, -SIGTERM, -HUP.
func signalSpec(a string) bool {
	if len(a) < 2 || a[0] != '-' || a[1] == '-' {
		return false
	}
	if a[1] == '$' {
		return true // kill -$SIG $pid: the first word after kill is its signal, whatever the variable holds (Security's #11211 SHOULD); a later -$pgid is a target and is refused
	}
	for _, r := range a[1:] {
		if !(r >= '0' && r <= '9' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z') {
			return false
		}
	}
	return true
}
