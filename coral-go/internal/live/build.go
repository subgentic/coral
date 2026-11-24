package live

import (
	"bytes"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/subgentic/coral/pkg/redact"
)

// AgentFacts is the input for one agent: the named facts the builder may read, filled by the caller from whatever store it has (LiveSource, a later
// slice). It is not a session row, so nothing else can reach a frame. Shown is the owner's choice at this computer; a new agent starts false.
type AgentFacts struct {
	RealName  string
	Role      string
	Status    Status
	TaskTitle string
	Shown     bool
	Chat      []ChatRow // the chosen agent's newest messages, when it is the one with chat on
}

// PostFacts is one board post: the author's real name, its text and its time.
type PostFacts struct {
	Author string
	Text   string
	At     time.Time
}

// Input is everything a frame is built from.
type Input struct {
	Agents []AgentFacts
	Posts  []PostFacts
}

// Options are the builder's settings. Seq is the frame's sequence, held by the caller.
type Options struct{ Seq uint64 }

const (
	windowPosts     = 3
	minBoundaryName = 4
	maxPosts        = 50
	maxChat         = 12 // the chat window: the last 12 messages
	maxText         = 500
	maxTask         = 120
	maxLabel        = 40
	hitNeigh        = 5 // posts withheld before and after a post that was withheld for a secret (design note section 4)
	ownerLabel      = "Operator"
)

var (
	idRE      = regexp.MustCompile(`coral://\S*`)
	pathRE    = regexp.MustCompile(`(/Users/|/home/|[A-Za-z]:\\|~/)`)
	mentionRE = regexp.MustCompile(`@[\p{L}\p{N}_][\p{L}\p{N}_.\- ]*`)
)

// clean drops control, bidirectional and zero-width characters, and cuts to max characters.
func clean(s string, max int) string {
	var b strings.Builder
	for _, r := range s {
		if unicode.Is(unicode.Cc, r) && r != '\n' && r != '\t' {
			continue
		}
		if unicode.Is(unicode.Cf, r) || r == '\u2028' || r == '\u2029' {
			continue
		}
		b.WriteRune(r)
	}
	rs := []rune(b.String())
	if len(rs) > max {
		rs = rs[:max]
	}
	return string(rs)
}

// scan reports whether text is safe to show: the redactor found nothing to change and did not fail. A failure, a refusing redactor or an overrun budget
// is "not safe": nothing goes out that no rule could judge (MUST 3).
func scan(red redact.Redactor, text string) bool {
	if text == "" {
		return true
	}
	out, err := red.Text([]byte(text))
	return err == nil && bytes.Equal(out, []byte(text))
}

// Build makes the frame. Every public field is set by name; a string that cannot be judged is left out or withheld.
func Build(in Input, opt Options, red redact.Redactor) Frame {
	f := Frame{V: 1, Seq: opt.Seq, Agents: []Agent{}, Posts: []Post{}}
	label := map[string]string{} // real name (lower case) -> public label, "" when hidden
	roles := make([]string, len(in.Agents))
	n := 0
	for i, a := range in.Agents {
		key := strings.ToLower(strings.TrimSpace(a.RealName))
		if !a.Shown {
			if key != "" {
				label[key] = ""
			}
			continue
		}
		n++
		l := clean(a.Role, maxLabel)
		if l != "" && (!scan(red, l) || !safeText(l) || namesAnyone(l, in.Agents)) {
			l = "" // a role no rule can judge, or that carries a real name, is not shown: Agent N instead
		}
		if l == "" {
			l = "Agent " + itoa(n)
		}
		roles[i] = l
		if key != "" {
			label[key] = l
		}
	}
	for i, a := range in.Agents {
		if !a.Shown {
			continue
		}
		task := ""
		if t, ok := publicText(clean(a.TaskTitle, maxTask), label); ok && scan(red, t) && scan(red, a.TaskTitle) {
			task = t
		}
		f.Agents = append(f.Agents, Agent{Role: roles[i], Status: statusWord(a.Status), Task: task, Chat: buildChat(a.Chat, label, red)})
	}
	posts := in.Posts
	if len(posts) > maxPosts {
		posts = posts[len(posts)-maxPosts:]
	}
	items := make([]Post, len(posts))
	hit := make([]bool, len(posts))
	for i, p := range posts {
		author, ok := publicAuthor(p.Author, label)
		text, ok2 := publicText(p.Text, label)
		if !ok || !ok2 {
			items[i] = Post{W: true}
			continue
		}
		if !scan(red, text) || !scan(red, p.Text) {
			items[i] = Post{W: true}
			hit[i] = true
			continue
		}
		items[i] = Post{From: author, Text: text, At: p.At.Unix()}
	}
	raws := make([]string, len(posts))
	for i, p := range posts {
		raws[i] = p.Text
	}
	for i, w := range spreadHits(red, raws, hit) {
		if w {
			items[i] = Post{W: true}
		}
	}
	for _, it := range items {
		if it.W && len(f.Posts) > 0 && f.Posts[len(f.Posts)-1].W {
			continue // a run of withheld posts is one marker: a count does not leak
		}
		f.Posts = append(f.Posts, it)
	}
	return f
}

// spreadHits is the rule both posts and chat messages follow: a secret can be cut across neighbouring items, so the joined text of each run of windowPosts items is scanned too, and a run that holds a hit, with
// no item in it a hit already, is a hit at every item of the run; then every item within hitNeigh before and after a hit is withheld (design note section 4). hit is changed; the result says which items to withhold.
// unixOrZero is a time's unix seconds, 0 for a message with no readable time (omitted from the frame).
func unixOrZero(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.Unix()
}

func spreadHits(red redact.Redactor, raws []string, hit []bool) []bool {
	for i := 0; i+1 < len(raws); i++ {
		for size := 2; size <= windowPosts; size++ { // runs of 2 and of 3: a token cut in two ends where the next item begins
			end := i + size
			if end > len(raws) {
				break
			}
			var parts []string
			explained := false // an item in the run that is a hit on its own already explains a hit of the run
			for j, r := range raws[i:end] {
				parts = append(parts, r)
				explained = explained || hit[i+j]
			}
			if explained {
				continue
			}
			for _, sep := range []string{"\n", ""} {
				if !scan(red, strings.Join(parts, sep)) {
					for j := i; j < end; j++ {
						hit[j] = true
					}
					break
				}
			}
		}
	}
	w := make([]bool, len(raws))
	for i := range hit {
		if !hit[i] {
			continue
		}
		for j := i - hitNeigh; j <= i+hitNeigh; j++ {
			if j >= 0 && j < len(w) {
				w[j] = true
			}
		}
	}
	return w
}

// buildChat makes the chosen agent's chat: the last maxChat messages, each cut at maxText, a real name replaced by its label, scanned whole (cut and uncut), the joined neighbours scanned too, and a hit withholds
// the messages around it (spreadHits). A message nobody can judge is {w:true}; a run of them is one marker.
func buildChat(rows []ChatRow, label map[string]string, red redact.Redactor) []Chat {
	if len(rows) > maxChat {
		rows = rows[len(rows)-maxChat:]
	}
	if len(rows) == 0 {
		return nil
	}
	items := make([]Chat, len(rows))
	hit := make([]bool, len(rows))
	raws := make([]string, len(rows))
	for i, r := range rows {
		raws[i] = r.Text
		from := "agent"
		if r.From == "person" {
			from = "person"
		}
		text, ok := publicText(r.Text, label)
		if !ok || text == "" {
			items[i] = Chat{W: true}
			continue
		}
		if !scan(red, text) || !scan(red, r.Text) {
			items[i] = Chat{W: true}
			hit[i] = true
			continue
		}
		items[i] = Chat{From: from, Text: text, At: unixOrZero(r.At)}
	}
	for i, w := range spreadHits(red, raws, hit) {
		if w {
			items[i] = Chat{W: true}
		}
	}
	var out []Chat
	for _, it := range items {
		if it.W && len(out) > 0 && out[len(out)-1].W {
			continue
		}
		out = append(out, it)
	}
	return out
}

// statusWord maps to the four words the public sees; anything else is idle.
func statusWord(s Status) string {
	switch s {
	case StatusWorking, StatusIdle, StatusWaiting, StatusAsleep:
		return string(s)
	}
	return string(StatusIdle)
}

// namesAnyone reports whether text holds any agent's real name.
func namesAnyone(t string, agents []AgentFacts) bool {
	for _, a := range agents {
		if r := strings.TrimSpace(a.RealName); r != "" && len(nameSpans(nameRE(r), r, t)) > 0 {
			return true
		}
	}
	return false
}

// namesLongestFirst orders the real names longest first, so "Ada Lovelace" is replaced before "Ada" and no half of a name is left behind (QA's SHOULD).
func namesLongestFirst(label map[string]string) []string {
	var names []string
	for real := range label {
		if real != "" {
			names = append(names, real)
		}
	}
	sort.Slice(names, func(i, j int) bool {
		if len(names[i]) != len(names[j]) {
			return len(names[i]) > len(names[j])
		}
		return names[i] < names[j]
	})
	return names
}

func safeText(s string) bool { return !pathRE.MatchString(s) && !idRE.MatchString(s) }

// publicAuthor is the label of a shown agent. A hidden agent's post is withheld (MUST 5). Someone who is no agent is the Operator, never a real name.
func publicAuthor(real string, label map[string]string) (string, bool) {
	l, known := label[strings.ToLower(strings.TrimSpace(real))]
	if !known {
		return ownerLabel, true
	}
	return l, l != ""
}

// publicText cleans a post, cuts a coral:// id, and replaces a real agent name or @mention with its public label. A post naming a hidden agent, an
// unknown @mention or a path is withheld (the owner's label rule would be void otherwise).
func publicText(text string, label map[string]string) (string, bool) {
	t := clean(text, 4*maxText) // names are replaced below, so cut after
	t = idRE.ReplaceAllString(t, "")
	if pathRE.MatchString(t) {
		return "", false
	}
	for _, m := range mentionRE.FindAllString(t, -1) {
		if !startsWithKnown(strings.TrimPrefix(m, "@"), label) {
			return "", false // an @mention of nobody we know
		}
	}
	for _, real := range namesLongestFirst(label) {
		l := label[real]
		spans := nameSpans(nameRE(real), real, t)
		if len(spans) == 0 {
			continue
		}
		if l == "" {
			return "", false
		}
		t = replaceSpans(t, spans, l)
	}
	t = clean(t, maxText)
	// nothing a real name is left: a name the replacement missed withholds the post (the owner's label rule would be void otherwise)
	for real := range label {
		if real != "" && len(nameSpans(nameRE(real), real, t)) > 0 {
			return "", false
		}
	}
	return t, true
}

// startsWithKnown reports whether s begins with a known real name (a mention may be followed by more words), ignoring case.
func startsWithKnown(s string, label map[string]string) bool {
	for real := range label {
		if real != "" && strings.HasPrefix(s, "") && prefixName(s, real) {
			return true
		}
	}
	return false
}

// prefixName reports whether s begins with the real name on a word boundary.
func prefixName(s, real string) bool {
	for _, sp := range nameSpans(nameRE(real), real, s) {
		if sp[0] == 0 || (sp[0] == 1 && s[0] == '@') {
			return true
		}
	}
	return false
}

// nameRE matches a real name, with an optional @ before it, ignoring case, with any run of white space (double spaces, line breaks, no-break spaces)
// between its words. The text is never sliced by an index found in a lower-cased copy: the indexes below are the original string's.
func nameRE(real string) *regexp.Regexp {
	words := strings.Fields(real)
	for i, w := range words {
		words[i] = regexp.QuoteMeta(w)
	}
	return regexp.MustCompile(`(?i)@?` + strings.Join(words, `[\s\p{Z}]+`))
}

func isWord(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' }

// nameSpans are the matches of re in t. A short name (under minBoundaryName characters) must stand on word boundaries, so "al" does not garble "also";
// a longer one is matched anywhere, so a name run into a word is still found.
func nameSpans(re *regexp.Regexp, real, t string) [][2]int {
	var out [][2]int
	short := utf8.RuneCountInString(real) < minBoundaryName
	for _, m := range re.FindAllStringIndex(t, -1) {
		if !short {
			out = append(out, [2]int{m[0], m[1]}) // a long name is matched anywhere: a name run into a word still names someone
			continue
		}
		if m[0] > 0 {
			if r, _ := utf8.DecodeLastRuneInString(t[:m[0]]); isWord(r) {
				continue
			}
		}
		if m[1] < len(t) {
			if r, _ := utf8.DecodeRuneInString(t[m[1]:]); isWord(r) {
				continue
			}
		}
		out = append(out, [2]int{m[0], m[1]})
	}
	return out
}

func replaceSpans(t string, spans [][2]int, repl string) string {
	var b strings.Builder
	last := 0
	for _, sp := range spans {
		b.WriteString(t[last:sp[0]])
		b.WriteString(repl)
		last = sp[1]
	}
	b.WriteString(t[last:])
	return b.String()
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var d []byte
	for n > 0 {
		d = append([]byte{byte('0' + n%10)}, d...)
		n /= 10
	}
	return string(d)
}
