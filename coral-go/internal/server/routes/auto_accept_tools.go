package routes

import (
	"path/filepath"
	"strings"
)

// commandRisk is why one command, with its arguments, is high-risk ("" when it isn't). at resolves paths from the
// directory the command runs in.
type commandRisk func(cmd string, args []string, at func([]string) []string, workDir string) string

// shellCommandRisks: the commands shellRiskFrom inspects, each with its rule (cd and the shell wrappers are handled
// there: one moves the directory later commands run in, the other holds a command of its own).
var shellCommandRisks = map[string]commandRisk{
	"rm":      rmRisk,
	"tee":     writeRisk,
	"cp":      writeRisk,
	"mv":      writeRisk,
	"install": writeRisk,
	"ln":      writeRisk,
	"dd":      writeRisk,
	"find":    findRisk,
	"su":      func(string, []string, func([]string) []string, string) string { return "it switches user (su)" },
	"perl":    perlRisk,
	"sed":     sedRisk,
	"chmod":   chmodRisk,
	"chown":   chmodRisk,
	"git":     gitRisk,
}

// launchCommandRisks: the commands whose writes #7106 reads (not part of the floor shellRiskSimple keeps).
var launchCommandRisks = map[string]commandRisk{
	"awk":      awkInplaceRisk,
	"gawk":     awkInplaceRisk,
	"mawk":     awkInplaceRisk,
	"nawk":     awkInplaceRisk,
	"curl":     curlRisk,
	"wget":     wgetRisk,
	"mkfifo":   operandRisk(map[string]bool{"-m": true, "--mode": true}),
	"shred":    operandRisk(map[string]bool{"-n": true, "-s": true, "--iterations": true, "--size": true, "--random-source": true}),
	"truncate": operandRisk(map[string]bool{"-s": true, "-r": true, "--size": true, "--reference": true}),
	"tar":      tarRisk,
	"bsdtar":   tarRisk,
	"unzip":    unzipRisk,
	"zip":      zipRisk,
	"7z":       sevenZipRisk,
	"7za":      sevenZipRisk,
	"7zr":      sevenZipRisk,
	"gzip":     compressRisk,
	"gunzip":   compressRisk,
	"bzip2":    compressRisk,
	"bunzip2":  compressRisk,
	"xz":       compressRisk,
	"unxz":     compressRisk,
	"zstd":     compressRisk,
	"cpio":     cpioRisk,
	"rsync":    rsyncRisk,
}

// dropNegation drops the leading ! words of a command (! rm, ! ! rm): the command after them is what runs.
func dropNegation(words []string) []string {
	for len(words) > 0 && words[0] == "!" {
		words = words[1:]
	}
	return words
}

func rmRisk(_ string, args []string, at func([]string) []string, workDir string) string {
	if hasFlag(args, "r", "R", "--recursive") {
		if t := outsideTarget(at(args), workDir); t != "" {
			return "it deletes recursively outside the working directory (" + t + ")"
		}
	}
	return ""
}

func writeRisk(cmd string, args []string, at func([]string) []string, workDir string) string {
	if t := outsideTarget(at(notDevices(writeTargets(cmd, args))), workDir); t != "" {
		return "it writes outside the working directory (" + t + ")"
	}
	return ""
}

func findRisk(_ string, args []string, at func([]string) []string, workDir string) string {
	if roots, deletes := findDeletes(args); deletes {
		if t := outsideTarget(at(roots), workDir); t != "" {
			return "it deletes files outside the working directory (" + t + ")"
		}
	}
	return ""
}

func perlRisk(_ string, args []string, at func([]string) []string, workDir string) string {
	if files, inPlace := perlInPlaceFiles(args); inPlace {
		if t := outsideTarget(at(files), workDir); t != "" {
			return "it edits a file outside the working directory (" + t + ")"
		}
	}
	return ""
}

func sedRisk(_ string, args []string, at func([]string) []string, workDir string) string {
	if files, inPlace := sedInPlaceFiles(args); inPlace {
		if t := outsideTarget(at(files), workDir); t != "" {
			return "it edits a file outside the working directory (" + t + ")"
		}
	}
	return ""
}

func chmodRisk(_ string, args []string, at func([]string) []string, workDir string) string {
	if hasFlag(args, "R", "", "--recursive") {
		if t := outsideTarget(at(args), workDir); t != "" {
			return "it changes ownership or permissions recursively outside the working directory (" + t + ")"
		}
	}
	return ""
}

// gitRisk checks subcommands that rewrite a remote or destroy uncommitted work.
// Git settings are checked on the original segment by gitQuotedConfigRisk before
// shellWords drops quotation; feeding those lossy words to gitExecKey again would
// mistake e.g. protocol.ext.allow='never' for a program-enabling value.
func gitRisk(_ string, args []string, _ func([]string) []string, _ string) string {
	sub, rest := gitSubcommand(args)
	switch sub {
	case "push":
		return gitPushRisk(rest)
	case "reset":
		for _, a := range rest {
			if a == "--hard" {
				return "it runs git reset --hard"
			}
		}
	case "clean":
		if !hasFlag(rest, "n", "", "--dry-run") {
			return "it runs git clean (deletes untracked files)"
		}
	case "checkout":
		for i, a := range rest {
			if a == "." || a == "-f" || a == "--force" || (a == "--" && i+1 < len(rest)) {
				return "it discards uncommitted changes (git checkout " + strings.Join(rest, " ") + ")"
			}
		}
	case "restore":
		return gitRestoreRisk(rest)
	}
	return ""
}

// gitPushRisk: a force push (-f, --force, --force-with-lease, --force-if-includes, a short-flag group with f, a
// +refspec, --mirror), or a remote branch deleted (--delete, -d, :branch); the first such argument decides.
func gitPushRisk(args []string) string {
	for _, a := range args {
		if a == "-f" || a == "--force" || a == "--mirror" || strings.HasPrefix(a, "--force-with-lease") || strings.HasPrefix(a, "--force-if-includes") ||
			(strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "--") && strings.Contains(a, "f")) ||
			(strings.HasPrefix(a, "+") && len(a) > 1) {
			return "it force-pushes"
		}
		if a == "--delete" || a == "-d" || (strings.HasPrefix(a, ":") && len(a) > 1) {
			return "it deletes a remote branch"
		}
	}
	return ""
}

// gitRestoreRisk: git restore touches the working tree unless it is --staged (-S) only.
func gitRestoreRisk(args []string) string {
	staged, worktree := false, false
	for _, a := range args {
		switch {
		case a == "--staged" || a == "-S":
			staged = true
		case a == "--worktree" || a == "-W":
			worktree = true
		case strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "--") && strings.Contains(a, "W"):
			worktree = true
		case strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "--") && strings.Contains(a, "S"):
			staged = true
		}
	}
	if !staged || worktree {
		return "it discards uncommitted changes (git restore)"
	}
	return ""
}

// findDeletes returns find's search roots and whether it deletes what it finds
// (-delete, or -exec/-execdir/-ok running rm, unlink, shred or rmdir).
func findDeletes(args []string) ([]string, bool) {
	var roots []string
	i := 0
	// Options before the search paths: -H, -L, -P, -D debugopts, -Olevel.
	for i < len(args) {
		switch a := args[i]; {
		case a == "-H" || a == "-L" || a == "-P" || strings.HasPrefix(a, "-O"):
			i++
			continue
		case a == "-D":
			i += 2
			continue
		}
		break
	}
	for ; i < len(args); i++ {
		a := args[i]
		if strings.HasPrefix(a, "-") || a == "(" || a == "!" {
			break
		}
		roots = append(roots, a)
	}
	if len(roots) == 0 {
		roots = []string{"."}
	}
	for j := i; j < len(args); j++ {
		switch args[j] {
		case "-delete":
			return roots, true
		case "-exec", "-execdir", "-ok", "-okdir":
			if j+1 < len(args) {
				switch filepath.Base(bareCommand(args[j+1])) {
				case "rm", "unlink", "shred", "rmdir":
					return roots, true
				}
			}
		}
	}
	return roots, false
}

// perlInPlaceFiles returns the files perl -i (-pi, -i.bak, -pie …) would edit, and whether
// it edits in place. The script is -e's value, or else the first operand.
func perlInPlaceFiles(args []string) ([]string, bool) {
	inPlace, script := false, false
	var operands []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--":
			operands = append(operands, args[i+1:]...)
			i = len(args)
		case strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "--") && len(a) > 1:
			// Walk the cluster left to right: a letter that takes a value takes the rest
			// of the cluster, or the next word when it is the cluster's last letter.
			// (-0777's octal digits match nothing: a record separator, not flags.)
		cluster:
			for k := 1; k < len(a); k++ {
				switch c := a[k]; {
				case c == 'i':
					inPlace = true
					break cluster // the rest is -i's backup suffix
				case c == 'e' || c == 'E':
					script = true
					if k == len(a)-1 {
						i++ // the program is the next word (-e 's/a/b/')
					}
					break cluster // else it is attached (-e's/a/b/)
				case strings.IndexByte("IMmlxCdD", c) >= 0:
					break cluster // -Ilib, -Mstrict, -l, -x… (and -0x1F's x): the rest is the value
				}
			}
		default:
			operands = append(operands, a)
		}
	}
	if !script && len(operands) > 0 {
		operands = operands[1:] // the first operand is the script file
	}
	return operands, inPlace
}

// sedInPlaceFiles returns the files sed -i would edit, and whether it edits in place.
func sedInPlaceFiles(args []string) ([]string, bool) {
	inPlace, script := false, false
	var operands []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-e" || a == "-f" || a == "--expression" || a == "--file":
			script = true
			i++
		case strings.HasPrefix(a, "--expression=") || strings.HasPrefix(a, "--file="):
			script = true
		case a == "--in-place" || strings.HasPrefix(a, "--in-place="):
			inPlace = true
		case strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "--") && len(a) > 1:
			if strings.Contains(a, "i") {
				inPlace = true
			}
			if strings.ContainsAny(a, "ef") {
				script = true
				i++
			}
		default:
			operands = append(operands, a)
		}
	}
	if !script && len(operands) > 0 {
		operands = operands[1:] // the first operand is the script
	}
	return operands, inPlace
}

// hasFlag reports a short flag letter (alone or combined, e.g. -rf) or a long flag.
func hasFlag(args []string, short1, short2, long string) bool {
	for _, a := range args {
		if a == long {
			return true
		}
		if strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "--") {
			if strings.Contains(a, short1) || (short2 != "" && strings.Contains(a, short2)) {
				return true
			}
		}
	}
	return false
}

// gitSubcommand skips git's global options (-C dir, -c k=v, --git-dir=…).
func gitSubcommand(args []string) (string, []string) {
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-C" || a == "-c":
			i++
		case strings.HasPrefix(a, "-"):
		default:
			return a, args[i+1:]
		}
	}
	return "", nil
}
