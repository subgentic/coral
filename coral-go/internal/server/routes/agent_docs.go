package routes

import (
	"errors"
	"html"
	"io"
	"io/fs"
	"net/http"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode"

	"github.com/go-chi/chi/v5"
	"gopkg.in/yaml.v3"
)

// AgentDocsHandler serves embedded API reference documentation.
type AgentDocsHandler struct {
	docsFS fs.FS
}

// AgentDocsFS is what the handler reads: a plain fs.FS of <name>.md files (the server's unzips the embedded .md.gz ones, #6814).
// AgentDocsFS has no production user: it is exported for the agent-docs tests in internal/server.
type AgentDocsFS = fs.FS

// NewAgentDocsHandler creates a handler that serves docs from the given filesystem.
func NewAgentDocsHandler(docsFS fs.FS) *AgentDocsHandler {
	return &AgentDocsHandler{docsFS: docsFS}
}

// List returns all available documentation files.
// GET /api/agent-docs
func (h *AgentDocsHandler) List(w http.ResponseWriter, r *http.Request) {
	entries, err := fs.ReadDir(h.docsFS, ".")
	if errors.Is(err, fs.ErrNotExist) {
		entries, err = nil, nil // a dev build without the docs folder lists none
	}
	if err != nil {
		errInternalServer(w, "failed to read docs directory")
		return
	}

	type docEntry struct {
		Name    string `json:"name"`
		Title   string `json:"title"`
		Summary string `json:"summary,omitempty"`
	}

	docs := []docEntry{} // [] when there are none, never null: the Docs tab reads null as a failed load
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		name := strings.TrimSuffix(e.Name(), ".md")
		docs = append(docs, docEntry{Name: name, Title: docTitle(h.docsFS, e.Name(), name), Summary: docSummary(h.docsFS, e.Name())})
	}
	sort.Slice(docs, func(i, j int) bool {
		// README first, then alphabetical
		if docs[i].Name == "README" {
			return true
		}
		if docs[j].Name == "README" {
			return false
		}
		return docs[i].Name < docs[j].Name
	})

	writeJSON(w, http.StatusOK, docs)
}

// Get returns the content of a single documentation file.
// GET /api/agent-docs/{name}
func (h *AgentDocsHandler) Get(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")

	// Sanitize: only allow alphanumeric, hyphens, underscores
	for _, c := range name {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_') {
			errBadRequest(w, "invalid doc name")
			return
		}
	}

	filename := name + ".md"
	content, err := fs.ReadFile(h.docsFS, filename)
	if err != nil {
		errNotFound(w, "doc not found: "+name)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"name":    name,
		"content": string(content),
		"path":    filepath.Join("agent_docs", filename),
	})
}

// gzipAller is a docs filesystem that holds its docs gzipped and can hand them over as one gzip stream (the server's, #6814).
type gzipAller interface {
	GzipAll() ([]byte, bool)
}

// acceptsGzip reports whether the request's Accept-Encoding allows gzip (a gzip;q=0 does not).
func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		coding, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if !strings.EqualFold(strings.TrimSpace(coding), "gzip") {
			continue
		}
		if q := strings.TrimSpace(params); strings.HasPrefix(q, "q=") {
			if v := strings.TrimPrefix(q, "q="); v == "0" || v == "0.0" || v == "0.00" || v == "0.000" {
				return false
			}
		}
		return true
	}
	return false
}

// GetAll returns all documentation files concatenated. A client that accepts gzip gets the docs as they are stored (gzipped, Content-Encoding: gzip); any other gets the plain text.
// GET /api/agent-docs/all
func (h *AgentDocsHandler) GetAll(w http.ResponseWriter, r *http.Request) {
	if g, ok := h.docsFS.(gzipAller); ok && acceptsGzip(r) {
		if body, ok := g.GzipAll(); ok {
			w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
			w.Header().Set("Content-Encoding", "gzip")
			w.Header().Add("Vary", "Accept-Encoding")
			w.WriteHeader(http.StatusOK)
			w.Write(body)
			return
		}
	}
	w.Header().Add("Vary", "Accept-Encoding")
	entries, err := fs.ReadDir(h.docsFS, ".")
	if err != nil {
		errInternalServer(w, "failed to read docs directory")
		return
	}

	var parts []string

	// README first
	if content, err := fs.ReadFile(h.docsFS, "README.md"); err == nil {
		parts = append(parts, string(content))
	}

	// Then all others alphabetically
	var names []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") || e.Name() == "README.md" {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)

	for _, name := range names {
		content, err := fs.ReadFile(h.docsFS, name)
		if err != nil {
			continue
		}
		parts = append(parts, string(content))
	}

	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(strings.Join(parts, "\n\n---\n\n")))
}

// docTitle is a doc's title for the list: its own first heading in sentence case (the style guide's), else its file name made readable the same way (#7516). The title-cased file name it replaced read
// "Using The Dashboard" and "Agent Ui".
func docTitle(docs fs.FS, file, name string) string {
	if h := firstHeading(docs, file); h != "" {
		return listTitle(sentenceCase(h))
	}
	return listTitle(sentenceCase(strings.ReplaceAll(name, "-", " ")))
}

// docTitleSoftCap: a list row is one short line. A title is taken up to its first colon or opening bracket, then words are added while it is shorter than this many characters (36: "Recover a task awaiting completion review" stays whole, "Coordination efficiency reporting & metrics architecture" is cut), so the word that crosses it
// stays (the sidebar can wrap one more word) and nothing is cut mid-word or ends in an ellipsis. The topic page still shows the full heading as the document's own h1.
const docTitleSoftCap = 36

// listTitle shortens a sentence-case heading for the Docs list (UI/UX's rules on #7516).
func listTitle(h string) string {
	if i := strings.IndexAny(h, ":("); i > 0 {
		h = strings.TrimSpace(h[:i])
	}
	var out []string
	n := 0
	for _, w := range strings.Fields(h) {
		if n >= docTitleSoftCap {
			break
		}
		out = append(out, w)
		n += len(w) + 1
	}
	for len(out) > 1 && strings.Trim(out[len(out)-1], "&,;-") == "" { // never end on a bare "&" or dash
		out = out[:len(out)-1]
	}
	return strings.Join(out, " ")
}

// firstHeading is the text of the first "# " line in the first 4 KiB of a doc, or "".
func firstHeading(docs fs.FS, file string) string {
	f, err := docs.Open(file)
	if err != nil {
		return ""
	}
	defer f.Close()
	buf := make([]byte, 4096)
	n, _ := io.ReadFull(f, buf)
	for _, line := range strings.Split(string(buf[:n]), "\n") {
		if t, ok := strings.CutPrefix(strings.TrimRight(line, "\r"), "# "); ok {
			return strings.TrimSpace(t)
		}
	}
	return ""
}

// docProperNouns are words kept capitalised in a sentence-case title; docAcronyms are kept (or made) upper case.
var (
	docProperNouns = map[string]string{"coral": "Coral", "claude": "Claude", "codex": "Codex", "gemini": "Gemini", "hub": "Hub", "windows": "Windows", "linux": "Linux", "macos": "macOS", "github": "GitHub"}
	docAcronyms    = map[string]string{"ui": "UI", "api": "API", "cli": "CLI", "json": "JSON", "url": "URL", "id": "ID", "mcp": "MCP", "poc": "POC", "http": "HTTP", "tls": "TLS", "html": "HTML", "ai": "AI"}
)

// sentenceCase writes a heading in sentence case: the first word capitalised, every other word lower case, except proper nouns (Coral, Hub), acronyms (API, UI, CLI) and words that are already
// code-like or carry a capital inside them (coral-agent, WebSocket, agent.json). A heading that is already in sentence case comes back unchanged.
func sentenceCase(s string) string {
	words := strings.Fields(s)
	for i, w := range words {
		core := strings.Trim(w, "()[]{}:,;.?\"'`")
		if core == "" {
			continue
		}
		words[i] = strings.Replace(w, core, wordCase(core, i == 0), 1)
	}
	return strings.Join(words, " ")
}

// wordCase is one word in a sentence-case title; first says it opens the title.
func wordCase(core string, first bool) string {
	low := strings.ToLower(core)
	switch {
	case core == "I":
		return core // the pronoun ("How do I...?")
	case docAcronyms[low] != "":
		return docAcronyms[low]
	case docProperNouns[low] != "":
		return docProperNouns[low]
	case strings.Contains(core, "-") && core != low && !strings.ContainsAny(core, "._/"):
		// Multi-Server: each part on its own, the first part carrying the title's first-word rule
		parts := strings.Split(core, "-")
		for j, part := range parts {
			parts[j] = wordCase(part, first && j == 0)
		}
		return strings.Join(parts, "-")
	case strings.ContainsAny(core, "-._/") && core == low:
		return core // code-like and already lower case (coral-agent, agent.json)
	case hasInnerCapital(core) || isAllUpper(core):
		return core // CamelCase and acronyms the list does not know (WebSocket, GPU)
	case first:
		return upperFirst(low)
	}
	return low
}

func hasInnerCapital(s string) bool {
	for i, r := range s {
		if i > 0 && unicode.IsUpper(r) {
			return true
		}
	}
	return false
}

func isAllUpper(s string) bool {
	letters := 0
	for _, r := range s {
		if unicode.IsLetter(r) {
			letters++
			if !unicode.IsUpper(r) {
				return false
			}
		}
	}
	return letters >= 2
}

func upperFirst(s string) string {
	for i, r := range s {
		return string(unicode.ToUpper(r)) + s[i+len(string(r)):]
	}
	return s
}

// docSummary returns the first prose paragraph, excluding headings, code, lists,
// tables and metadata. List clients receive plain text and never need to fetch
// every document just to describe its topic.
func docSummary(docs fs.FS, file string) string {
	data, err := fs.ReadFile(docs, file)
	if err != nil {
		return ""
	}
	text := docComment.ReplaceAllString(string(data), "")
	if summary := explicitDocSummary(text); summary != "" {
		return plainDocSummary(summary)
	}
	lines := strings.Split(text, "\n")
	var paragraph []string
	fence := ""
	frontmatter := len(lines) > 0 && strings.TrimSpace(lines[0]) == "---"
	for i, raw := range lines {
		line := strings.TrimSpace(raw)
		if frontmatter {
			if i > 0 && (line == "---" || line == "...") {
				frontmatter = false
			}
			continue
		}
		if fence != "" {
			if strings.HasPrefix(line, fence) {
				fence = ""
			}
			continue
		}
		if strings.HasPrefix(line, "```") || strings.HasPrefix(line, "~~~") {
			if len(paragraph) > 0 {
				break
			}
			fence = line[:3]
			continue
		}
		if line == "" {
			if len(paragraph) > 0 {
				break
			}
			continue
		}
		// Setext headings are prose-looking lines followed by an underline.
		if i+1 < len(lines) && docUnderline.MatchString(strings.TrimSpace(lines[i+1])) {
			continue
		}
		if strings.HasPrefix(raw, "    ") || strings.HasPrefix(raw, "\t") || docBlock.MatchString(line) {
			if len(paragraph) > 0 {
				break
			}
			continue
		}
		paragraph = append(paragraph, line)
	}
	return plainDocSummary(strings.Join(paragraph, " "))
}

func plainDocSummary(line string) string {
	line = docRefLink.ReplaceAllString(line, "$1")
	line = docInlineHTML.ReplaceAllStringFunc(line, func(part string) string {
		if strings.HasPrefix(part, "`") {
			return part
		} // inline code may contain literal <placeholders>
		if docAutolink.MatchString(part) {
			return docAutolink.ReplaceAllString(part, "$1")
		}
		return ""
	})
	line = markdownLine(line)
	for _, re := range docEmphasis {
		line = re.ReplaceAllString(line, "$1$2$3")
	}
	line = docEscape.ReplaceAllString(line, "$1")
	return strings.Join(strings.Fields(html.UnescapeString(line)), " ")
}

// Authors can describe a topic independently of its historical or verification
// notes. Only front matter and a quote before the first body paragraph qualify;
// a warning later in a document must never replace its summary.
func explicitDocSummary(text string) string {
	lines := strings.Split(text, "\n")
	start := 0
	if len(lines) > 0 && strings.TrimSpace(lines[0]) == "---" {
		for i := 1; i < len(lines); i++ {
			marker := strings.TrimSpace(lines[i])
			if marker != "---" && marker != "..." {
				continue
			}
			var meta struct {
				Summary string `yaml:"summary"`
			}
			if yaml.Unmarshal([]byte(strings.Join(lines[1:i], "\n")), &meta) == nil && strings.TrimSpace(meta.Summary) != "" {
				return meta.Summary
			}
			start = i + 1
			break
		}
	}
	for _, raw := range lines[start:] {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "# ") {
			continue
		}
		if strings.HasPrefix(line, "> ") {
			return strings.TrimSpace(strings.TrimPrefix(line, "> "))
		}
		return ""
	}
	return ""
}

var (
	docComment    = regexp.MustCompile(`(?s)<!--.*?-->`)
	docUnderline  = regexp.MustCompile(`^(?:=+|-+)\s*$`)
	docBlock      = regexp.MustCompile(`^(?:#{1,6}(?:\s|$)|>|[-+*]\s|[0-9]+[.)]\s|\||\[[^]]+\]:|[-*_]{3,}\s*$|=+\s*$|<[/!a-zA-Z])`)
	docRefLink    = regexp.MustCompile(`!?\[([^]]+)\]\[[^]]*\]`)
	docAutolink   = regexp.MustCompile(`<((?:https?://|mailto:)[^>]+)>`)
	docInlineHTML = regexp.MustCompile("`+[^`]*`+|<[^>]*>")
	docEscape     = regexp.MustCompile(`\\([[:punct:]])`)
	docEmphasis   = []*regexp.Regexp{
		regexp.MustCompile(`(^|[\s(])__(\S(?:.*?\S)?)__($|[\s).,;:!?])`),
		regexp.MustCompile(`(^|[\s(])_(\S(?:.*?\S)?)_($|[\s).,;:!?])`),
	}
)
