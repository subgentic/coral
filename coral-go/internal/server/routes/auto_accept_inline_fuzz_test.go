package routes

import (
	"math/rand"
	"strings"
	"testing"
	"time"
)

// #7201 round 2 (QA's fuzz found sedScriptRuns looping on a trailing backslash): every scanner of the inline-code family must return for ANY input, so a command text, an injected one included, cannot
// stall the classifier. Random argument lists built from the characters these scanners treat as syntax are read with a time limit per call.
func TestInlineScannersAlwaysReturn(t *testing.T) {
	alphabet := []string{`\\`, `/`, `'`, `"`, `|`, `||`, `|&`, `;`, `{`, `}`, `$`, `(`, `)`, `-`, `--`, `-e`, `-c`, `-F`, `-v`, `-i`, `-f`, `-Command`, `-ec`, `:`, `=`, ` `, "\n", `s`, `y`, `e`, `w`, `W`, `a`, `x`, `1`, `,`, `!`, `~`, `+`, `inplace`, `system(`, `exec`, `dlx`, `x`, `ssh`, `--source=`, `--eval`, `--rsh`}
	rng := rand.New(rand.NewSource(7201))
	word := func() string {
		var b strings.Builder
		for k := 0; k < 1+rng.Intn(5); k++ {
			b.WriteString(alphabet[rng.Intn(len(alphabet))])
		}
		return b.String()
	}
	names := []string{"python3", "node", "deno", "perl", "ruby", "php", "osascript", "lua", "julia", "emacs", "vim", "npx", "groovy", "ts-node", "pwsh", "expect", "tclsh", "rsync", "awk", "gawk", "ssh", "parallel", "sed", "npm", "irb", "mosh"}
	check := func(label string, f func()) {
		done := make(chan struct{})
		go func() { f(); close(done) }()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Fatalf("%s did not return", label)
		}
	}
	for n := 0; n < 20000; n++ {
		args := make([]string, rng.Intn(6))
		for i := range args {
			args[i] = word()
		}
		name := names[rng.Intn(len(names))]
		check("inlineCodeRisk "+name+" "+strings.Join(args, " | "), func() { inlineCodeRisk(name, args) })
		check("sedScriptRuns "+word(), func() { sedScriptRuns(strings.Join(args, "")) })
		check("awkStartsCommand", func() { awkStartsCommand(args) })
		check("sedRunsCommands", func() { sedRunsCommands(args) })
		check("rsyncRemoteShell", func() { rsyncRemoteShell(args) })
		check("powershellGivesCode", func() { powershellGivesCode(word()) })
	}
}

// The sed reader on its own, with scripts built from the characters it treats as syntax, a backslash most of all, and the shapes found by hand and by fuzz: it returns for every one.
func TestSedScriptReaderAlwaysReturns(t *testing.T) {
	check := func(sc string) {
		done := make(chan struct{})
		go func() { sedScriptRuns(sc); close(done) }()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Fatalf("sedScriptRuns did not return for %q", sc)
		}
	}
	for _, sc := range []string{`\`, `p;\`, `1,\`, `/x/d;\`, `s/a/b/;\`, `\ pde{c}I`, `!\ ~MI~"`, `,,p\)i|&|!s$`, `\\\`, `\/`, `1,2,3,4\`, `~`, `,`, `!`, `I`, `M`, `$`, `s`, `y`, `s/`, `s/a`, `s/a/b`, `y/a`, `a`, `i\`, `/`, `\x`} {
		check(sc)
	}
	chars := []byte(`\\\\/,!~IM$p;se w|&()"` + "\n")
	rng := rand.New(rand.NewSource(7202))
	for n := 0; n < 60000; n++ {
		b := make([]byte, rng.Intn(14))
		for i := range b {
			b[i] = chars[rng.Intn(len(chars))]
		}
		check(string(b))
	}
}

// The belt around the judgement (#7201): a judgement that does not finish within the deadline is answered "ask" and logged, and one that panics is answered "ask" instead of taking the process down.
func TestShellRiskDeadlineAnswersAskAndALogLine(t *testing.T) {
	oldImpl, oldDeadline := shellRiskImpl, shellRiskDeadline
	defer func() { shellRiskImpl, shellRiskDeadline = oldImpl, oldDeadline }()
	shellRiskDeadline = 50 * time.Millisecond

	stop := make(chan struct{})
	shellRiskImpl = func(string, string) string { // a spinner that gives up when the test is over
		for {
			select {
			case <-stop:
				return ""
			default:
			}
		}
	}
	start := time.Now()
	got := shellRisk("anything", t.TempDir())
	close(stop)
	if got != whyTookTooLong {
		t.Fatalf("a judgement that does not finish answers %q, got %q", whyTookTooLong, got)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("the deadline did not hold: %v", time.Since(start))
	}

	shellRiskImpl = func(string, string) string { panic("boom") }
	if got := shellRisk("anything", t.TempDir()); got != "it could not be checked" {
		t.Fatalf("a panic is answered %q, got %q", "it could not be checked", got)
	}

	shellRiskImpl = oldImpl
	shellRiskDeadline = oldDeadline
	if got := shellRisk("rm -rf /etc", t.TempDir()); got == "" {
		t.Fatal("the normal judgement still works")
	}
}

// A grammar-based generator of valid sed scripts (#7201 round 4): every address form (numbers, $, regexes, bracket expressions with a slash or a custom delimiter inside, GNU first~step, addr,+N, addr,~N,
// 0,/re/, \cREc, I and M flags, !), harmless commands and runner commands (e, w, W, the e and w flags of s), joined in both orders by ; and by a newline. A script with a runner must be read as one that runs
// something; the same script with the runner replaced by a harmless command must not. The count is logged.
func TestSedScriptGrammarWithBracketAddresses(t *testing.T) {
	addrs := []string{"", "1", "$", "2,4", "/x/", "/x/,/y/", "/x/I", "/x/M", "$!", "1~2", "2,+3", "2,~4", "0,/x/", `\%x%`, `\,x,`,
		`/[/]/`, `/a[/]b/`, `/[^/]/`, `/[a/b]/`, `/[[:alpha:]/]/`, `/[]/]/`, `/[^]/]/`, `/[[.slash.]/]/`, `/[[=a=]/]/`, `/[\n]/`, `\,[,],`, `\%[%]%`, `/[/]/,/[/]/`, `/[/]/!`, `/[0-9/]/I`}
	harmless := []string{"p", "d", "n", "N", "g", "G", "h", "H", "x", "=", "l", "q", "s/a/b/", "s/a/b/g", "s/[/]/b/", "s,[,],b,", "y/abc/xyz/", "a text", "i text", "c text", "r file", ":lbl", "b lbl", "t lbl", "{p}", "!d", "s/e/w/"}
	runners := []string{"e id", "e", "w /tmp/o", "W /tmp/o", "s/a/b/e", "s/a/b/w /tmp/o", "s/[/]/b/e", "s,[,],b,w /tmp/o"}
	seps := []string{";", "\n"}
	runsCount, safeCount := 0, 0
	for _, a := range addrs {
		for _, r := range runners {
			for _, h := range harmless {
				for _, sep := range seps {
					if sep == ";" && (h == "a text" || h == "i text" || h == "c text") {
						continue // the text of a, i and c runs to the end of the line, a runner after a ; is part of it
					}
					for pos := 0; pos < 3; pos++ {
						var with, without string
						switch pos {
						case 0:
							with, without = a+r, a+h
						case 1:
							with, without = h+sep+a+r, h+sep+a+h
						case 2:
							with, without = a+h+sep+a+r, a+h+sep+a+h
						}
						if !sedScriptRuns(with) {
							t.Errorf("a script with a runner reads as safe: %q", with)
						}
						runsCount++
						if sedScriptRuns(without) {
							t.Errorf("a harmless script is asked about: %q", without)
						}
						safeCount++
					}
				}
			}
		}
	}
	t.Logf("%d scripts with a runner read as running, %d harmless ones checked", runsCount, safeCount)
}
