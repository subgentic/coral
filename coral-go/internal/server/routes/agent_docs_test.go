package routes

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
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
		"Merge queue":  "Merge queue",
		"How do I...?": "How do I...?", // the pronoun stays a capital (#10093)
		"How Do I...?": "How do I...?",
		"Hooks":        "Hooks",
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
			core := strings.Trim(w, "()[]{}:,;.?&\"'`")
			if core == "" || core == strings.ToLower(core) {
				continue
			}
			low := strings.ToLower(core)
			assert.True(t, core == "I" || docProperNouns[low] != "" || docAcronyms[low] != "" || hasInnerCapital(core) || isAllUpper(core), "%s: %q looks title-cased in %q", d.Name, w, d.Title)
		}
	}
	assert.Equal(t, "Using the dashboard", byName["using-the-dashboard"])
	assert.Equal(t, "Agent UI", byName["agent-ui"])
	assert.Equal(t, "Personal tasks", byName["agent-tasks"])
	assert.Equal(t, "Team configuration", byName["team-config"])
	assert.Equal(t, "Coordination efficiency reporting", byName["coordination-reporting"])
	assert.Equal(t, "What Coral stores on this computer", byName["what-coral-stores"])
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

// UI/UX's rules on #7516: a list row is one short line: the heading up to its first colon or opening bracket, words added while the title is shorter than 36 characters (the crossing word stays).
func TestListTitleIsOneShortLine(t *testing.T) {
	for in, want := range map[string]string{
		"Personal tasks: coral-agent CLI and API": "Personal tasks",
		"Agent UI (POC)":                  "Agent UI",
		"Team configuration (agent.json)": "Team configuration",
		"Coordination efficiency reporting & metrics architecture": "Coordination efficiency reporting",
		"What Coral stores on this computer":                       "What Coral stores on this computer",
		"Task workflows and completion artifacts":                  "Task workflows and completion artifacts",
		"Using the dashboard":                                      "Using the dashboard",
		"Settings & system API":                                    "Settings & system API",
		"Cross-team messaging":                                     "Cross-team messaging",
		"Multi-server Hub API":                                     "Multi-server Hub API",
		"Coral API reference":                                      "Coral API reference",
		"Recover a task awaiting completion review":                "Recover a task awaiting completion review",
		"A very long heading & more":                               "A very long heading & more",
	} {
		assert.Equal(t, want, listTitle(sentenceCase(in)), in)
		assert.LessOrEqual(t, len(listTitle(sentenceCase(in))), 32+20, in)
	}
	assert.NotContains(t, listTitle("Words, and more words that go on and on and on, & more"), "&", "never ends on a bare ampersand")
	assert.Equal(t, "MCP servers", sentenceCase("mcp Servers"))
}

func TestAgentDocsSummary(t *testing.T) {
	cases := []struct{ name, body, want string }{
		{"leading-quote", "# Title\n\n> A **useful** summary with `<name>`.\n\nChecked against an old release.", "A useful summary with <name>."},
		{"front-matter", "---\nsummary: 'Use [topics](https://example.test): a guide.'\n---\n# Title\n\n> A different summary.\n\nMeta notes.", "Use topics: a guide."},
		{"empty-front-matter", "---\nsummary: ''\n---\n# Title\n\n> Use the leading line.\n\nMeta notes.", "Use the leading line."},
		{"later-quote", "# Title\n\nThe actual introduction.\n\n> A later warning.", "The actual introduction."},
		{"front-matter-no-summary", "---\ntitle: Metadata\n---\n# Title\n\nThe introduction.", "The introduction."},
		{"prose", "# Title\n\nRead **topics** with `coral-agent docs`\nand [examples](https://example.test).\n\nSecond paragraph.", "Read topics with coral-agent docs and examples."},
		{"blocks", "---\ntitle: metadata\n---\n# Title\n\n<!-- hidden\ncomment -->\n```sh\nnot prose\n```\n\n- bullet\n\n| table |\n| --- |\n\nThe _first_ __real__ paragraph &amp; [reference][ref].\n\n[ref]: https://example.test", "The first real paragraph & reference."},
		{"setext", "Title\n=====\n\nBody with <em>inline</em> markup and user_id.", "Body with inline markup and user_id."},
		{"empty", "# Only heading\n\n~~~\nonly code\n~~~\n", ""},
		{"code-markup", "# Title\n\nUse `<topic>` and <strong>words</strong>, or <https://example.test>.", "Use <topic> and words, or https://example.test."},
		{"unicode", "# Title\n\nRésumé — use \\*literal\\* marks.", "Résumé — use *literal* marks."},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fsys := fstest.MapFS{"topic.md": {Data: []byte(tc.body)}}
			rec := httptest.NewRecorder()
			NewAgentDocsHandler(fsys).List(rec, httptest.NewRequest(http.MethodGet, "/api/agent-docs", nil))
			require.Equal(t, http.StatusOK, rec.Code)
			var got []map[string]string
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
			require.Len(t, got, 1)
			assert.Equal(t, tc.want, got[0]["summary"])
			if tc.want == "" {
				assert.NotContains(t, got[0], "summary")
			}
		})
	}
	assert.Empty(t, docSummary(fstest.MapFS{}, "missing.md"))
}

func TestDocsMetaIntroductionsHaveExplicitSummaries(t *testing.T) {
	docs := os.DirFS("../../../agent_docs")
	rec := httptest.NewRecorder()
	NewAgentDocsHandler(docs).List(rec, httptest.NewRequest(http.MethodGet, "/api/agent-docs", nil))
	var list []struct{ Name, Summary string }
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &list))
	summaries := map[string]string{}
	for _, doc := range list {
		summaries[doc.Name] = doc.Summary
	}
	for _, name := range []string{"troubleshooting", "using-the-dashboard", "worked-demos"} {
		data, err := fs.ReadFile(docs, name+".md")
		require.NoError(t, err)
		explicit := explicitDocSummary(string(data))
		require.NotEmpty(t, explicit, name)
		assert.Equal(t, plainDocSummary(explicit), summaries[name], name)
		assert.Less(t, len([]rune(summaries[name])), 100, name+": a short topic description")
		assert.NotContains(t, summaries[name], "v1.")
		assert.NotContains(t, summaries[name], "checked against")
	}
}

// #10093 v2 (Desktop #10087): the pages a newcomer reads first carry no source paths and no agent CLI flags (they are for developers, and a newcomer cannot use them). The example files of the quickstart's demo (stringutil.go) are not source paths.
func TestNewcomerPagesHaveNoSourcePathsOrAgentFlags(t *testing.T) {
	pages := []string{"how-do-i", "quickstart", "using-the-dashboard", "worked-demos", "workflow-quickstart", "troubleshooting"}
	path := regexp.MustCompile("`(?:internal|pkg|cmd|tests)/[^`]*`|`[A-Za-z0-9_./-]*\\.(?:go|js):?[0-9]*`|\\((?:`[A-Za-z]+` in )?`(?:internal|pkg|cmd)/[^`]*`\\)")
	flag := regexp.MustCompile("--(?:permission-mode|dangerously-skip-permissions|effort)\\b|model_reasoning_effort")
	for _, p := range pages {
		b, err := os.ReadFile(filepath.Join("..", "..", "..", "agent_docs", p+".md"))
		require.NoError(t, err, p)
		text := strings.ReplaceAll(string(b), "\r\n", "\n")
		for _, m := range path.FindAllString(text, -1) {
			if strings.Contains(m, "stringutil") {
				continue
			}
			t.Errorf("%s.md names a source path: %s", p, m)
		}
		for _, m := range flag.FindAllString(text, -1) {
			t.Errorf("%s.md names an agent CLI flag: %s", p, m)
		}
	}
}

// #10093 v2 (Beta tester): the steps name the real controls. The row menu has Sleep, Archive and Kill Session (no "Remove Agent"), and the phone dialog is "Use on your phone" with Enable, a QR once it is on, and Use Coral Hub instead.
func TestHowDoIStepsNameTheRealControls(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "agent_docs", "how-do-i.md"))
	require.NoError(t, err)
	text := strings.ReplaceAll(string(b), "\r\n", "\n")
	assert.NotContains(t, text, "Remove Agent", "the row menu has no Remove Agent")
	for _, want := range []string{"**Sleep**", "**Archive**", "**Kill Session**", "**Use on your phone**", "**Enable**", "**Use Coral Hub instead**"} {
		assert.Contains(t, text, want)
	}
	rows, err := os.ReadFile(filepath.Join("..", "..", "..", "pkg", "frontend", "static", "session_rows.js"))
	require.NoError(t, err)
	for _, item := range []string{"Sleep", "Archive", "Kill Session"} {
		assert.Contains(t, string(rows), "\n                "+item+"\n", "the row menu really has "+item)
	}
}

// #10484 (Desktop pass 16:26): How do I...? answers three more questions a newcomer asks, and each step names a control the dashboard really has.
func TestHowDoIAnswersThreeMoreQuestions(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "agent_docs", "how-do-i.md"))
	require.NoError(t, err)
	text := strings.ReplaceAll(string(b), "\r\n", "\n")
	for _, heading := range []string{"## Switch to the light theme", "## Copy a chat, or keep part of it", "## Find an old chat"} {
		assert.Contains(t, text, heading)
	}
	static := filepath.Join("..", "..", "..", "pkg", "frontend", "static")
	read := func(name string) string {
		b, err := os.ReadFile(filepath.Join(static, name))
		require.NoError(t, err, name)
		return string(b)
	}
	fields, chat, menu, board, lists, saved := read("settings_fields.js"), read("chat_messages.js"), read("message_menu.js"), read("board_chat.js"), read("history_list.js"), read("saved_marks.js")
	for want, src := range map[string]string{
		"label: 'Theme'": fields, "label: 'Light'": fields, "Customize Theme": fields, // the Theme select with Light and System, and its Customize Theme button
		"aria-label=\"Copy message\"": chat, "item(menu, 'Copy'": menu, "Save for later": saved,
		"Export Markdown": board, "label: 'Search chats'": lists,
	} {
		assert.Contains(t, src, want, "the dashboard has the control the answer names: "+want)
	}
}

// #10765 (Desktop #10764): How do I...? also answers how to continue an old chat, give an agent a file, and what the permission modes allow; each step names a control the dashboard really has, and Settings'
// Learn more beside Default permission mode points at the last one.
func TestHowDoIAnswersContinueAFileAndThePermissionModes(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "agent_docs", "how-do-i.md"))
	require.NoError(t, err)
	text := strings.ReplaceAll(string(b), "\r\n", "\n")
	for _, heading := range []string{"## Continue an old chat", "## Give an agent a file", "## What the permission modes allow"} {
		assert.Contains(t, text, heading)
	}
	for _, mode := range []string{"**Default:**", "**Plan:**", "**Accept edits:**", "**Auto:**", "**Bypass permissions:**", "**Don't ask:**"} {
		assert.Contains(t, text, mode, "one line for each mode")
	}
	for _, cli := range []string{"**Claude**", "**Codex**", "**Antigravity**", "**Gemini**", "**Pi**"} {
		assert.Contains(t, text, cli, "Auto says where the CLIs differ")
	}
	static := filepath.Join("..", "..", "..", "pkg", "frontend")
	read := func(rel ...string) string {
		b, err := os.ReadFile(filepath.Join(append([]string{static}, rel...)...))
		require.NoError(t, err, rel)
		return string(b)
	}
	chats, composer, modals, history, fields, modes := read("static", "mailbox_chats.js"), read("templates", "includes", "views", "live_session.html"), read("templates", "includes", "modals.html"), read("templates", "includes", "views", "history_session.html"), read("static", "settings_fields.js"), read("static", "permission_flags.js")
	for want, src := range map[string]string{
		"Continue this chat": chats, ">Continue this chat</button>": history, // the row's play button and the chat page's button
		"Resume session": modals, "Working Directory": modals, "Use this folder": modals, "Rejoin board": modals, // the dialog the button opens
		"type @ for a file in this folder": composer, "Attach an image": composer, // the message box's corner button
		"Not set (Auto)": fields, "Bypass permissions": fields, "Don't ask": fields, // the Settings select the answer is about
		"Pi has no permission prompts": modes, "Workspace sandbox": modes, // the per-CLI facts of Auto
	} {
		assert.Contains(t, src, want, "the dashboard has what the answer names: "+want)
	}
	assert.Contains(t, fields, "docs: { topic: 'how-do-i', answer: 'What the permission modes allow' }", "Learn more beside Default permission mode opens that answer in Docs")
}

// #10605 and #10595: the launch choice is New project, not New team: no shipped agent doc names the old button.
func TestAgentDocsNameNewProjectNotNewTeam(t *testing.T) {
	entries, err := os.ReadDir(filepath.Join("..", "..", "..", "agent_docs"))
	require.NoError(t, err)
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		b, err := os.ReadFile(filepath.Join("..", "..", "..", "agent_docs", e.Name()))
		require.NoError(t, err)
		assert.NotContains(t, string(b), "New team", e.Name()+" names the old button: it is New project")
	}
}

// #10595 (Desktop Docs pass): How do I...? says how to stop a reply that is still running, with the controls as the dashboard has them, and ends with where to go when still stuck.
func TestHowDoIStopsAReplyAndEndsWithWhereToGo(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "agent_docs", "how-do-i.md"))
	require.NoError(t, err)
	text := strings.ReplaceAll(string(b), "\r\n", "\n")
	assert.Contains(t, text, "**Stop a reply that is still running:**")
	for _, want := range []string{"**Stop**", "**Escape**", "**Stop the agent**"} {
		assert.Contains(t, text, want)
	}
	front := filepath.Join("..", "..", "..", "pkg", "frontend")
	read := func(rel string) string {
		b, err := os.ReadFile(filepath.Join(front, rel))
		require.NoError(t, err, rel)
		return string(b)
	}
	assert.Contains(t, read("static/css/chat.css"), `content: "Stop"`, "the Esc button really says Stop while the agent works")
	assert.Contains(t, read("static/agent_keys.js"), "'Stop the agent'", "a phone's Send button is really named Stop the agent")
	assert.Contains(t, read("static/agent_keys.js"), "Escape in the empty box", "and Escape in the empty box really stops")
	idx := strings.LastIndex(text, "## Still stuck?")
	require.GreaterOrEqual(t, idx, 0, "the page ends with Still stuck?")
	tail := text[idx:]
	assert.NotContains(t, tail[len("## Still stuck?"):], "\n## ", "and it is the last section")
	for _, link := range []string{"(troubleshooting.md)", "(https://github.com/subgentic/coral)", "[Forum]("} {
		assert.Contains(t, tail, link)
	}
	welcome := read("templates/index.html")
	forum := regexp.MustCompile(`\[Forum\]\((https://[^)]+)\)`).FindStringSubmatch(tail)
	require.Len(t, forum, 2)
	assert.Contains(t, welcome, `href="`+forum[1]+`"`, "the Forum link is the one the dashboard's welcome page has")
}
