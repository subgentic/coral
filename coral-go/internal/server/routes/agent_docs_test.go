package routes

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// missingFS is a docs folder that isn't there (a dev build that never synced agent_docs).
type missingFS struct{}

func (missingFS) Open(string) (fs.File, error) { return nil, fs.ErrNotExist }

// #3532: a build without agent docs lists none as [] (never null, which the Docs tab reads
// as a failed load), and README comes first.
func TestAgentDocsList(t *testing.T) {
	list := func(fsys fstest.MapFS) string {
		rec := httptest.NewRecorder()
		NewAgentDocsHandler(fsys).List(rec, httptest.NewRequest("GET", "/api/agent-docs", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d", rec.Code)
		}
		return strings.TrimSpace(rec.Body.String())
	}
	if got := list(fstest.MapFS{}); got != "[]" {
		t.Errorf("no docs: got %s, want []", got)
	}
	rec := httptest.NewRecorder()
	NewAgentDocsHandler(missingFS{}).List(rec, httptest.NewRequest("GET", "/api/agent-docs", nil))
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Errorf("no docs folder: got %d %s, want 200 []", rec.Code, rec.Body.String())
	}
	got := list(fstest.MapFS{"hooks.md": {Data: []byte("# h")}, "README.md": {Data: []byte("# r")}, "x.txt": {Data: []byte("x")}})
	if !strings.HasPrefix(got, `[{"name":"README"`) || !strings.Contains(got, `"name":"hooks"`) || strings.Contains(got, "x.txt") {
		t.Errorf("got %s", got)
	}
}

// #7516: the Docs list shows each doc's own first heading in sentence case (the style guide's), acronyms and product names kept, never the title-cased file name ("Using The Dashboard", "Agent Ui").
func TestSentenceCaseTitles(t *testing.T) {
	for in, want := range map[string]string{
		"Using the Dashboard":                       "Using the dashboard",
		"Agent UI (POC)":                            "Agent UI (POC)",
		"Coral API Reference":                       "Coral API reference",
		"Multi-Server Hub API":                      "Multi-server Hub API",
		"Settings & System API":                     "Settings & system API",
		"Personal Tasks: coral-agent CLI and API":   "Personal tasks: coral-agent CLI and API",
		"Team Configuration (agent.json)":           "Team configuration (agent.json)",
		"WebSocket API":                             "WebSocket API",
		"Cross-team Messaging":                      "Cross-team messaging",
		"What Coral stores on this computer":        "What Coral stores on this computer",
		"Recover a task awaiting completion review": "Recover a task awaiting completion review",
		"agent ui":            "Agent UI",
		"using the dashboard": "Using the dashboard",
		"Coordination Efficiency Reporting & Metrics": "Coordination efficiency reporting & metrics",
		"Merge queue": "Merge queue",
		"Hooks":       "Hooks",
	} {
		assert.Equal(t, want, sentenceCase(in), in)
		assert.Equal(t, want, sentenceCase(want), "idempotent: "+want)
	}
}

func TestTheDocsListUsesEachDocsOwnHeading(t *testing.T) {
	docs := os.DirFS("../../../agent_docs")
	h := NewAgentDocsHandler(docs)
	rec := httptest.NewRecorder()
	h.List(rec, httptest.NewRequest(http.MethodGet, "/api/agent-docs", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	var list []struct{ Name, Title string }
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &list))
	entries, err := os.ReadDir("../../../agent_docs")
	require.NoError(t, err)
	md := 0
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".md") {
			md++
		}
	}
	require.Len(t, list, md, "every doc is listed")
	byName := map[string]string{}
	for _, d := range list {
		byName[d.Name] = d.Title
		assert.NotEmpty(t, d.Title, d.Name)
		assert.Equal(t, sentenceCase(d.Title), d.Title, "%s: already sentence case", d.Name)
		// no word after the first starts upper case unless it is a proper noun, an acronym or carries a capital inside (the old title-casing made every word capital)
		words := strings.Fields(d.Title)
		for _, w := range words[1:] {
			core := strings.Trim(w, "()[]{}:,;.&\"'`")
			if core == "" || core == strings.ToLower(core) {
				continue
			}
			low := strings.ToLower(core)
			assert.True(t, docProperNouns[low] != "" || docAcronyms[low] != "" || hasInnerCapital(core) || isAllUpper(core), "%s: %q looks title-cased in %q", d.Name, w, d.Title)
		}
	}
	assert.Equal(t, "Using the dashboard", byName["using-the-dashboard"])
	assert.Equal(t, "Agent UI (POC)", byName["agent-ui"])
	assert.Equal(t, "Coral API reference", byName["README"])
	assert.NotContains(t, byName["settings-system"], "System", "sentence case")
	// a doc with no heading falls back to its file name, readable
	mem := fstest.MapFS{"no-heading-api.md": {Data: []byte("text only\n")}, "with.md": {Data: []byte("\n# A Real Title Here\n")}}
	rec = httptest.NewRecorder()
	NewAgentDocsHandler(mem).List(rec, httptest.NewRequest(http.MethodGet, "/api/agent-docs", nil))
	var got []struct{ Name, Title string }
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	titles := map[string]string{}
	for _, d := range got {
		titles[d.Name] = d.Title
	}
	assert.Equal(t, "No heading API", titles["no-heading-api"])
	assert.Equal(t, "A real title here", titles["with"])
}
