package agent

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// MissingCommandIn reports whether out holds a shell's "no such command" error for binary. It is the backup under the CLI checks (#353): the refusal before the launch line is typed is the
// main guard, and this reads the error a typed line leaves in the pane. The wordings, with where each comes from:
//   - Windows PowerShell 5.1: "The term 'codex' is not recognized as the name of a cmdlet, function, script file, or operable program."
//   - PowerShell 7: "The term 'codex' is not recognized as a name of a cmdlet, function, script file, or executable program." (PowerShell's own DiscoveryExceptions.resx,
//     https://github.com/PowerShell/PowerShell/blob/master/src/System.Management.Automation/resources/DiscoveryExceptions.resx, key CommandNotFoundException)
//   - cmd: "'codex' is not recognized as an internal or external command, operable program or batch file."
//   - POSIX shells: "bash: codex: command not found", "zsh: command not found: codex", "sh: 1: codex: not found".
//
// These are English: a Windows or a shell in another language words them differently and the backup does not match. A pane narrower than the sentence wraps it, so the PowerShell and cmd
// phrases are matched on the text with its whitespace and line breaks collapsed. An error about another command does not count.
func MissingCommandIn(out, binary string) bool {
	b := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(binary)), ".exe")
	if b == "" || out == "" {
		return false
	}
	q := regexp.QuoteMeta(b)
	name := `['"` + "`" + `]?` + q + `(?:\.(?:exe|cmd|bat|ps1))?['"` + "`" + `]?`
	low := strings.ToLower(out)
	collapsed := strings.Join(strings.Fields(low), " ")
	for _, re := range []*regexp.Regexp{
		regexp.MustCompile(`the term ` + name + ` is not recognized as (?:the|a) name of a`),
		regexp.MustCompile(`(?:^| )` + name + ` is not recognized as an internal or external command`),
	} {
		if re.MatchString(collapsed) {
			return true
		}
	}
	for _, re := range []*regexp.Regexp{
		regexp.MustCompile(`(?m)^(?:[^\n:]*:\s*)*` + q + `: (?:command )?not found\s*$`),
		regexp.MustCompile(`(?m)^[^\n]*command not found: ` + q + `\s*$`),
	} {
		if re.MatchString(low) {
			return true
		}
	}
	return false
}

// promptEnd is how a shell's prompt ends, after any trailing blanks: "$", "#", "%" or ">" (bash, sh, zsh, PowerShell's "PS C:\\w>", cmd's
// "C:\\w>"), and the marks of common custom prompts.
var promptEnd = regexp.MustCompile(`(?:[$#%>]|❯|λ|»)$`)

// looksLikePrompt reports whether row, the last on the screen, ends like a shell's prompt (QA's ConPTY run on #253: a program's last line of output,
// "[stub] up", was taken for the prompt and the error above it marked).
func looksLikePrompt(row string) bool {
	return promptEnd.MatchString(strings.TrimSpace(row))
}

// promptPiece reports whether row, right above the prompt's last row (or above another piece), is the prompt wrapped from there: as wide as the
// pane, and shaped like a prompt, not like a person's output (the coral-go-team Security's Finding B on #253): no "not found" or "not recognized"
// in it, not one character repeated (a ruler), and no run of spaces (columns, a wide ls line). A row of output taken for the prompt would make an
// older error the end of the block.
func promptPiece(row string, width int) bool {
	if strings.TrimSpace(row) == "" || utf8.RuneCountInString(row) != width {
		return false
	}
	low := strings.ToLower(row)
	if strings.Contains(low, "not found") || strings.Contains(low, "not recognized") || strings.Contains(row, "  ") {
		return false
	}
	t := strings.TrimSpace(row)
	return strings.Trim(t, t[:1]) != "" // all one character: a ruler
}

// answerLines is the most of the screen above the bottom prompt that is read as the shell's latest answer: Windows PowerShell's error record, the
// longest, is the sentence and five trailer lines, and a narrow pane breaks each of them over several rows (QA's 30-column ConPTY screen: 16).
const answerLines = 24

// MissingCommandAtBottom reports whether the shell's LATEST answer, right above the prompt at the bottom of screen, is its "no such command"
// error for binary (#353's safety net; the coral-go-team Security's INFO on #173). Coral's quiet launch clears the screen, so the line it typed is
// not there to anchor on; the bottom is. The prompt the shell came back to is the last row, with the rows above it that it wrapped from (a row as
// wide as the pane continues on the next); the error must END the block of rows right above it, a blank row ending the block.
// A pane breaks a long line at its last column, mid-word or not, so the block is compared with its row breaks and all spacing taken out. The same
// words higher up, or followed by any other output or a typed command, are not the shell's latest answer and do not count.
func MissingCommandAtBottom(screen, binary string) bool {
	b := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(binary)), ".exe")
	if b == "" {
		return false
	}
	rows := strings.Split(strings.ReplaceAll(screen, "\r\n", "\n"), "\n")
	// The pane's width, as the screen shows it: the widest row, when at least two rows reach it (a pane that wrapped anything fills its rows to
	// the last column). Otherwise nothing is taken as wrapped: the longest line is just the longest line.
	width, full := 0, 0
	for _, r := range rows {
		switch n := utf8.RuneCountInString(r); {
		case n > width:
			width, full = n, 1
		case n == width:
			full++
		}
	}
	if full < 2 {
		width = -1
	}
	blank := func(r string) bool { return strings.TrimSpace(r) == "" }
	trimBlank := func() {
		for len(rows) > 0 && blank(rows[len(rows)-1]) {
			rows = rows[:len(rows)-1]
		}
	}
	trimBlank()
	if len(rows) < 2 {
		return false // a prompt alone, or nothing: no answer
	}
	if !looksLikePrompt(rows[len(rows)-1]) {
		return false // the bottom is not a shell's prompt (a program's own output, still running): the shell has not answered
	}
	rows = rows[:len(rows)-1] // the prompt's last row
	for len(rows) > 0 && promptPiece(rows[len(rows)-1], width) {
		rows = rows[:len(rows)-1] // a full row above it: the prompt wrapped from there
	}
	trimBlank()
	start := len(rows)
	for start > 0 && len(rows)-start < answerLines && !blank(rows[start-1]) {
		start--
	}
	block := rows[start:]
	if len(block) == 0 {
		return false
	}
	var flat strings.Builder
	for _, l := range block {
		for _, r := range strings.ToLower(l) {
			if !unicode.IsSpace(r) {
				flat.WriteRune(r)
			}
		}
	}
	q := regexp.QuoteMeta(b)
	name := `['"` + "`" + `]?` + q + `(?:\.(?:exe|cmd|bat|ps1))?['"` + "`" + `]?`
	sentence := `theterm` + name + `isnotrecognizedas(?:the|a)nameofacmdlet,function,scriptfile,or(?:operable|executable)program\.(?:checkthespellingofthename,orifapathwasincluded,verifythatthepathiscorrectandtryagain\.)?`
	// Windows PowerShell 5.1's record under the sentence: "At line:1 char:1", the command and its underline ("+ codex", "+ ~~~~~"), then
	// "+ CategoryInfo : ObjectNotFound: (codex:String) [], CommandNotFoundException" and "+ FullyQualifiedErrorId : CommandNotFoundException".
	trailer := `(?:atline:\d+char:\d+(?:\+[^+]*)*\+categoryinfo:objectnotfound:[^+]*commandnotfoundexception\+fullyqualifiederrorid:commandnotfoundexception)?`
	for _, re := range []*regexp.Regexp{
		// POSIX shells: "bash: codex: command not found", "sh: 1: codex: not found", "zsh: command not found: codex".
		regexp.MustCompile(`(?:^|:)` + q + `:(?:command)?notfound$`),
		regexp.MustCompile(`commandnotfound:` + q + `$`),
		// Windows PowerShell 5.1 (with its record) and 7.
		regexp.MustCompile(sentence + trailer + `$`),
		// cmd.
		regexp.MustCompile(name + `isnotrecognizedasaninternalorexternalcommand,operableprogramorbatchfile\.$`),
	} {
		if re.MatchString(flat.String()) {
			return true
		}
	}
	return false
}
