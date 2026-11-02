package routes

import (
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// A message to the Operator is read on a phone, between other things (#12517): a one-line summary, then one point or step per line. A wall of text or numbered steps run together on one line
// are refused, with the way to format them, before anything is stored.
const maxOperatorRunOnChars = 280

var operatorTagRE = regexp.MustCompile(`(?i)(^|[^\p{L}\p{N}])@operator($|[^\p{L}\p{N}-])`)

// inlineStepRE finds a step marker inside a line: "1. ", "2) " after a space or an opening bracket.
var inlineStepRE = regexp.MustCompile(`(?:^|[\s(:;,])(\d{1,2})[.)]\s+\S`)

// operatorFormatProblem is why text to the Operator is badly formatted, or "" when it is fine or is not to the Operator. A text is to the Operator when it @mentions them.
func operatorFormatProblem(content string) string {
	text := strings.TrimSpace(content)
	if !operatorTagRE.MatchString(text) {
		return ""
	}
	if !strings.Contains(text, "\n") && utf8.RuneCountInString(text) > maxOperatorRunOnChars {
		return fmt.Sprintf("it is %d characters on one line", utf8.RuneCountInString(text))
	}
	for _, line := range strings.Split(text, "\n") {
		prev := -1
		for _, m := range inlineStepRE.FindAllStringSubmatch(line, -1) {
			n, _ := strconv.Atoi(m[1])
			if prev >= 0 && n == prev+1 {
				return "it has numbered steps (1. ... 2. ...) on one line"
			}
			prev = n
		}
	}
	return ""
}

// refuseOperatorFormat answers 400 when content is a badly formatted message to the Operator and reports whether it did. The Operator's own text is never refused.
func refuseOperatorFormat(w http.ResponseWriter, sender, content string) bool {
	if strings.EqualFold(strings.TrimSpace(sender), operatorIdentity) {
		return false
	}
	problem := operatorFormatProblem(content)
	if problem == "" {
		return false
	}
	msg := "not posted: a message to the Operator is read on a phone, and " + problem + ". Write a one-line summary, then one point or step per line (a line of running text under about " +
		strconv.Itoa(maxOperatorRunOnChars) + " characters, each numbered step on its own line), and put long content in an artifact (coral-agent artifact upload) with its link"
	writeJSON(w, http.StatusBadRequest, map[string]any{"error": msg, "message": msg, "code": "operator_format", "not_sent": true})
	return true
}
