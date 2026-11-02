package routes

import (
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// A message to the Operator is read on a phone, between other things (#12517): a one-line summary, then one point or step per line. A line of running text that is too long, or numbered steps
// run together on one line, are refused with the way to format them, before anything is stored.
const maxOperatorLine = 280

// operatorStartRE is a text that starts with @Operator: that is what makes a post one to the Operator (an ask to them is decided by who it asks). A passing @Operator inside a note to an agent is not.
var operatorStartRE = regexp.MustCompile(`(?i)^@operator($|[^\p{L}\p{N}-])`)

// inlineStepRE finds a step marker inside a line: "1. ", "2) " after a space or an opening bracket.
var inlineStepRE = regexp.MustCompile(`(?:^|[\s(:;,])(\d{1,2})[.)]\s+\S`)

// bareTokenRE: a line that is only a link (or a path) has no spaces to break at.
var bareLinkRE = regexp.MustCompile(`^\S+$`)

// startsWithOperator reports whether text opens with an @Operator tag.
func startsWithOperator(content string) bool {
	return operatorStartRE.MatchString(strings.TrimSpace(content))
}

// operatorFormatProblem is why text to the Operator is badly formatted, or "" when it is fine. The caller decides that the text is to the Operator.
func operatorFormatProblem(content string) string {
	fenced := false
	for _, raw := range strings.Split(strings.TrimSpace(content), "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "```") {
			fenced = !fenced
			continue
		}
		if n := utf8.RuneCountInString(line); n > maxOperatorLine && !fenced && !bareLinkRE.MatchString(line) && !onlyCodeSpan(line) {
			return fmt.Sprintf("a line is %d characters", n)
		}
		prev := -1
		for _, m := range inlineStepRE.FindAllStringSubmatch(line, -1) {
			n, _ := strconv.Atoi(m[1])
			if prev >= 0 && n == prev+1 {
				return "a line has numbered steps (1. ... 2. ...) run together"
			}
			prev = n
		}
	}
	return ""
}

// onlyCodeSpan: the whole line is one `code span`.
func onlyCodeSpan(line string) bool {
	return len(line) > 2 && strings.HasPrefix(line, "`") && strings.HasSuffix(line, "`") && !strings.Contains(line[1:len(line)-1], "`")
}

// refuseOperatorFormat answers 400 when content is a badly formatted message to the Operator and reports whether it did. The Operator's own text is never refused. toOperator is whether the
// message is to them (it starts with @Operator, or it asks them).
func refuseOperatorFormat(w http.ResponseWriter, sender, content string, toOperator bool) bool {
	if !toOperator || strings.EqualFold(strings.TrimSpace(sender), operatorIdentity) {
		return false
	}
	problem := operatorFormatProblem(content)
	if problem == "" {
		return false
	}
	msg := "not posted: a message to the Operator is read on a phone, and " + problem + ". Write a one-line summary, then one point or step per line (a line of running text under about " +
		strconv.Itoa(maxOperatorLine) + " characters, each numbered step on its own line), and put long content in an artifact (coral-agent artifact upload) with its link"
	writeJSON(w, http.StatusBadRequest, map[string]any{"error": msg, "message": msg, "code": "operator_format", "not_sent": true})
	return true
}
