package live

import (
	"bytes"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/subgentic/coral/pkg/redact"
)

// AgentFacts is the input for one agent: the named facts the builder may read, filled by the caller from whatever store it has (LiveSource, a later
// slice). It is not a session row, so nothing else can reach a frame. Shown is the owner's choice at this computer; a new agent starts false.
type AgentFacts struct {
	RealName  string
	Label     string
	Role      string
	CLI       string
	Status    Status
	TaskTitle string
	Shown     bool
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
	maxPosts   = 50
	maxText    = 500
	maxTask    = 120
	maxLabel   = 40
	hitNeigh   = 5 // posts withheld before and after a post that was withheld for a secret (design note section 4)
	ownerLabel = "Operator"
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
		if unicode.Is(unicode.Cf, r) || r == ' ' || r == ' ' {
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
	n := 0
	for _, a := range in.Agents {
		key := strings.ToLower(strings.TrimSpace(a.RealName))
		if !a.Shown {
			if key != "" {
				label[key] = ""
			}
			continue
		}
		n++
		l := clean(a.Label, maxLabel)
		if l == "" {
			l = clean(a.Role, maxLabel)
		}
		if l == "" {
			l = "Agent " + itoa(n)
		}
		if key != "" {
			label[key] = l
		}
		task := clean(a.TaskTitle, maxTask)
		if !scan(red, task) || !safeText(task) {
			task = ""
		}
		f.Agents = append(f.Agents, Agent{Label: l, Role: clean(a.Role, maxLabel), CLI: clean(a.CLI, maxLabel), Status: string(a.Status), Task: task})
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
			items[i] = Post{Withheld: true, Text: MarkerMessage}
			continue
		}
		if !scan(red, text) || !scan(red, p.Text) {
			items[i] = Post{Withheld: true, Text: MarkerMessage}
			hit[i] = true
			continue
		}
		items[i] = Post{Author: author, Text: text, At: p.At.Unix()}
	}
	for i := range hit {
		if !hit[i] {
			continue
		}
		for j := i - hitNeigh; j <= i+hitNeigh; j++ {
			if j >= 0 && j < len(items) {
				items[j] = Post{Withheld: true, Text: MarkerMessage}
			}
		}
	}
	for _, it := range items {
		if it.Withheld && len(f.Posts) > 0 && f.Posts[len(f.Posts)-1].Withheld {
			continue // a run of withheld posts is one marker: a count does not leak
		}
		f.Posts = append(f.Posts, it)
	}
	return f
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
		name := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(m, "@")))
		if l := longestKnown(name, label); l == nil {
			return "", false // an @mention of nobody we know
		}
	}
	for real, l := range label {
		if real == "" || !containsFold(t, real) {
			continue
		}
		if l == "" {
			return "", false
		}
	}
	for real, l := range label {
		if real == "" {
			continue
		}
		t = replaceFold(t, "@"+real, l)
		t = replaceFold(t, real, l)
	}
	return clean(t, maxText), true
}

// longestKnown finds a known real name at the start of s (a mention may be followed by more words).
func longestKnown(s string, label map[string]string) *string {
	for real, l := range label {
		if real != "" && strings.HasPrefix(s, real) {
			l := l
			return &l
		}
	}
	return nil
}

func containsFold(s, sub string) bool { return strings.Contains(strings.ToLower(s), sub) }

func replaceFold(s, old, repl string) string {
	if old == "" {
		return s
	}
	low, lo := strings.ToLower(s), strings.ToLower(old)
	var b strings.Builder
	i := 0
	for {
		j := strings.Index(low[i:], lo)
		if j < 0 {
			b.WriteString(s[i:])
			return b.String()
		}
		b.WriteString(s[i : i+j])
		b.WriteString(repl)
		i += j + len(lo)
	}
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
