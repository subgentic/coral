package routes

import (
	"regexp"
	"strings"
)

// The last open forms of auto-accept (#7201, left open on purpose in #7106): a command that runs code it is given inline (python -c, node -e, perl -e, ruby -e, php -r, awk with system()), a
// command run on another computer (ssh host command) and one that runs commands for a list (parallel). Same policy as the rare launchers: what the code does is not modelled and a person decides.
// Running a script FILE (python3 x.py, node x.js, perl x.pl) is left as it is, and so are the interpreters' version and help flags and a module run (python3 -m pytest).

// inlineCodeRisk is why a command that runs inline code, a remote command or a command list is high-risk ("" when it is none of them).
func inlineCodeRisk(cmd string, args []string) string {
	name := interpreterName(cmd)
	switch name {
	case "python", "node", "deno", "bun", "perl", "ruby", "php":
		if inlineCodeFlag(name, args) {
			// perl -pi -e 's/a/b/' file and perl -ne 'print' file are the common text edits, and the tests since #3207 hold them to perlRisk's reading of the files they touch: a one-liner whose program
			// calls nothing that runs a command or changes the file system stays with that rule. Every other inline program, and every perl that reads its program from its input, asks.
			if name == "perl" && perlExplicitProgram(args) && !perlProgramRuns(args) {
				return ""
			}
			return "it runs inline code (" + cmd + ")"
		}
	case "awk":
		if awkRunsCommands(args) {
			return "it runs commands from an awk program (" + cmd + ")"
		}
	case "ssh":
		if sshRunsRemotely(args) {
			return "it runs a command on another computer (ssh)"
		}
	case "parallel":
		if !onlyInfoFlags(args) {
			return "it runs commands for a list (parallel)"
		}
	}
	return ""
}

var (
	pythonNameRe = regexp.MustCompile(`^(python|pypy)[0-9.]*$`)
	awkNameRe    = regexp.MustCompile(`^(awk|gawk|mawk|nawk|busybox-awk)$`)
)

// interpreterName is the family of a command name: python3.11 and pypy3 are python, nodejs is node, gawk is awk.
func interpreterName(cmd string) string {
	switch {
	case pythonNameRe.MatchString(cmd):
		return "python"
	case cmd == "node" || cmd == "nodejs":
		return "node"
	case awkNameRe.MatchString(cmd):
		return "awk"
	}
	switch cmd {
	case "deno", "bun", "perl", "ruby", "php", "ssh", "parallel":
		return cmd
	}
	return ""
}

// inlineCodeFlag reports whether the options before the script (or module) of an interpreter give it code to run: python -c, node -e/-p (--eval, --print), deno eval, bun -e/--eval, perl -e/-E (also in a
// group: -pe, -lane), ruby -e (also -ne, -pe), php -r/-R/-B/-E (--run). Options after the script belong to the script. A bare interpreter, or "-", reads its program from its input.
func inlineCodeFlag(name string, args []string) bool {
	if name == "deno" {
		return len(args) > 0 && args[0] == "eval"
	}
	// short options that take the rest of their word (or the next word) as a value: the letters after them in a group are not options
	valued := map[string]string{"python": "WXQ", "node": "r", "bun": "r", "perl": "IMmFiCdDV", "ruby": "IrCFKEeTxW", "php": "dzcnfhtqS"}[name]
	sawScript := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--":
			sawScript = i+1 < len(args)
			i = len(args)
		case !strings.HasPrefix(a, "-"):
			sawScript = true
			i = len(args)
		case strings.HasPrefix(a, "--"):
			long := strings.SplitN(a, "=", 2)[0]
			switch {
			case name == "node" && (long == "--eval" || long == "--print"), name == "bun" && (long == "--eval" || long == "--print"), name == "php" && long == "--run":
				return true
			case name == "node" && (long == "--require" || long == "--import" || long == "--loader" || long == "--experimental-loader") && !strings.Contains(a, "="):
				i++
			}
		default:
			for k := 1; k < len(a); k++ {
				c := a[k]
				if inlineLetter(name, c) {
					return true
				}
				if strings.IndexByte(valued, c) >= 0 {
					if k+1 == len(a) && ((name != "perl" && (c == 'r' || c == 'W' || c == 'X' || c == 'I' || c == 'M' || c == 'm')) || (name == "perl" && c == 'I')) {
						i++ // the value is the next word
					}
					break
				}
			}
		}
	}
	// An interpreter given no script at all reads its program from its input (python3 < x.py, echo ... | node), except when it only answers a question (--version, -V, -h).
	return !sawScript && !onlyInfoFlags(args)
}

// inlineLetter says whether the short option letter c of an interpreter gives it code.
func inlineLetter(name string, c byte) bool {
	switch name {
	case "python":
		return c == 'c'
	case "node", "bun":
		return c == 'e' || c == 'p'
	case "perl":
		return c == 'e' || c == 'E'
	case "ruby":
		return c == 'e'
	case "php":
		return c == 'r' || c == 'R' || c == 'B' || c == 'E'
	}
	return false
}

// onlyInfoFlags reports whether every argument is a version or help request (or there is none to a command that needs some): --version, -V, -v, -h, --help, -?.
func onlyInfoFlags(args []string) bool {
	if len(args) == 0 {
		return false
	}
	for _, a := range args {
		switch a {
		case "--version", "-V", "-v", "--help", "-h", "-?", "-version", "--info", "-i":
		default:
			return false
		}
	}
	return true
}

var awkSystemRe = regexp.MustCompile(`\bsystem\s*\(|\|&`)

// awkPipeRe reports whether an awk program starts a command: system(), a coprocess (|&), or a single | with a string on either side (print | "sort", "date" | getline); || is the or operator.
func awkStartsCommand(prog string) bool {
	if awkSystemRe.MatchString(prog) {
		return true
	}
	for i := 0; i < len(prog); i++ {
		if prog[i] != '|' || (i > 0 && prog[i-1] == '|') || (i+1 < len(prog) && prog[i+1] == '|') {
			continue
		}
		j := i + 1
		for j < len(prog) && (prog[j] == ' ' || prog[j] == '\t') {
			j++
		}
		k := i - 1
		for k >= 0 && (prog[k] == ' ' || prog[k] == '\t') {
			k--
		}
		if (j < len(prog) && prog[j] == '"') || (k >= 0 && prog[k] == '"') {
			return true
		}
	}
	return false
}

// awkRunsCommands reports whether an awk program (the first word that is not an option, unless -f names a file) starts a command: system(), or a pipe to or from one.
func awkRunsCommands(args []string) bool {
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-f" || a == "--file" || strings.HasPrefix(a, "-f"):
			return false // a program file: left as it is
		case a == "-v" || a == "-F" || a == "--assign" || a == "--field-separator" || a == "-e" || a == "--source":
			if a == "-e" || a == "--source" {
				if i+1 < len(args) && awkStartsCommand(args[i+1]) {
					return true
				}
			}
			i++
		case strings.HasPrefix(a, "-"):
		default:
			return awkStartsCommand(strings.Join(args[i:], " "))
		}
	}
	return false
}

// sshRunsRemotely reports whether an ssh command opens a session or runs a command on another computer: anything but its version and its configuration queries (-V, -G, -Q).
func sshRunsRemotely(args []string) bool {
	for _, a := range args {
		if a == "-V" || a == "-G" || strings.HasPrefix(a, "-Q") {
			return false
		}
	}
	return true
}

// perlExplicitProgram reports whether perl is given its program with -e or -E (not from its input).
func perlExplicitProgram(args []string) bool {
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" || !strings.HasPrefix(a, "-") {
			break
		}
		if a == "-I" { // its value is the next word
			i++
			continue
		}
		if strings.HasPrefix(a, "--") {
			continue
		}
		for k := 1; k < len(a); k++ {
			if a[k] == 'e' || a[k] == 'E' {
				return true
			}
			if strings.IndexByte("IMmFiCdDV", a[k]) >= 0 {
				break
			}
		}
	}
	return false
}

var perlRunsRe = regexp.MustCompile(`\b(system|exec|fork|unlink|rmdir|rename|mkdir|chmod|chown|chdir|kill|qx|open|opendir|sysopen|syscall|require|eval|do|glob|truncate|symlink|link|utime|socket|connect|exit)\b|\b(File|IO|Cwd|POSIX|Socket|Net|LWP|HTTP|IPC|Fcntl|Proc|Win32)::|\b(use|no)\s+(lib|POSIX|Socket)\b|` + "`" + `|%ENV|\$ENV\b|\bpipe\b|\|\s*["']|["']\s*\|[^|]|<\(|\bsh\b`)

// perlProgramRuns reports whether the text of a perl command line (its -e programs, and -M modules) uses something that runs a command, reaches the file system or the network, or loads code: those ask.
func perlProgramRuns(args []string) bool {
	text := strings.Join(args, " ")
	for _, a := range args {
		if strings.HasPrefix(a, "-M") || strings.HasPrefix(a, "-m") {
			if strings.Contains(a, "::") || !strings.EqualFold(a[2:], "strict") && !strings.EqualFold(a[2:], "warnings") && !strings.EqualFold(a[2:], "utf8") {
				return true
			}
		}
	}
	return perlRunsRe.MatchString(text)
}
