package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Chat search finds what an agent said, not only what a person asked (#10050, the Desktop tester searched All chats for a word from a reply): the text the index keeps for a Claude transcript holds the
// assistant's replies as well as the user's messages.
func TestClaudeSearchBodyHoldsTheRepliesToo(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "00000000-0000-4000-8000-000000010050.jsonl")
	lines := []string{
		`{"type":"user","timestamp":"2026-10-28T00:00:00Z","message":{"role":"user","content":"please explain the build"}}`,
		`{"type":"assistant","timestamp":"2026-10-28T00:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"The zebracorn pipeline compiles first."}]}}`,
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cur, err := readClaudeFrom(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	body := buildFTSBody(cur.summary, &cur.fts)
	if !strings.Contains(body, "build") {
		t.Errorf("the user's words are not in the search body: %q", body)
	}
	if !strings.Contains(body, "zebracorn") {
		t.Errorf("the assistant's reply is not in the search body, so All chats cannot find it: %q", body)
	}
}
