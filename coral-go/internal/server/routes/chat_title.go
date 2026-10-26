package routes

import (
	"regexp"
	"strings"

	"github.com/subgentic/coral/internal/agent"
)

// chatTitleLimit is how much of a chat's first message its title keeps.
const chatTitleLimit = 120

var (
	mdLinkR  = regexp.MustCompile(`!?\[([^\]]*)\]\([^)]*\)`)
	mdLeadR  = regexp.MustCompile(`^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)`)
	mdTicksR = regexp.MustCompile("`+")
	// mdWrapRs strip ** ... **, ~~ ... ~~ and * ... * only where they wrap a word or words (a mark right after a space or the start and right before a space, a stop or the end): a lone * ("2 * 3"), a path's ~
	// ("~/work/app") and a name's own marks ("user_id", "__init__") are the person's own text. Underscore emphasis is left alone for the same reason: in a code-minded first message it is a name far more often than emphasis.
	mdWrapRs = func() []*regexp.Regexp {
		var out []*regexp.Regexp
		for _, d := range []string{`**`, `~~`, `*`} {
			q := regexp.QuoteMeta(d)
			out = append(out, regexp.MustCompile(`(^|[\s(])`+q+`(\S(?:.*?\S)?)`+q+`($|[\s).,;:!?])`))
		}
		return out
	}()
)

// markdownLine is a message's first non-empty line with its markdown taken off (a heading's marks, a list bullet, emphasis that wraps words, code ticks, a link's address), on one line.
func markdownLine(text string) string {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "```") || line == "---" {
			continue
		}
		line = mdLinkR.ReplaceAllString(line, "$1")
		line = mdLeadR.ReplaceAllString(line, "")
		for _, r := range mdWrapRs {
			line = r.ReplaceAllString(line, "$1$2$3")
		}
		line = mdTicksR.ReplaceAllString(line, "")
		if line = strings.Join(strings.Fields(line), " "); line != "" {
			return line
		}
	}
	return ""
}

// chatTitle is the one title of a chat that the History list and the sidebar both show (#7756): the title its notes give it (the agent's or the person's own), else the first real message the person typed
// with its markdown taken off and cut to one line, else the agent's name alone. The launch prompt Coral gave the agent is never a title: a row indexed before it was kept out of the first message is read here too.
func chatTitle(summaryTitle, firstUserMessage, displayName, agentName string) string {
	if t := strings.TrimSpace(summaryTitle); t != "" {
		return t
	}
	if !agent.IsLaunchPromptText(firstUserMessage) {
		if t := markdownLine(firstUserMessage); t != "" {
			if r := []rune(t); len(r) > chatTitleLimit {
				t = strings.TrimSpace(string(r[:chatTitleLimit])) + "…"
			}
			return t
		}
	}
	if displayName != "" {
		return displayName
	}
	return agentName
}
