package board

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// board_message_counts is kept by triggers on board_messages (#9503). SQLite fires the delete trigger for REPLACE
// only with recursive triggers on, so a REPLACE INTO board_messages that drops a row would leave its count behind.
// Every writer uses INSERT or UPDATE; this fails on any source (tests included) that spells a REPLACE into the table.
func TestNoReplaceIntoBoardMessages(t *testing.T) {
	re := regexp.MustCompile("(?is)(INSERT\\s+OR\\s+REPLACE|REPLACE)\\s+INTO\\s+[\"`\\[]?board_messages\\b")
	root := filepath.Join("..", "..")
	var bad []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if n := d.Name(); n == "node_modules" || n == ".git" {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "board_messages_replace_census_test.go") {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		if re.Match(b) {
			bad = append(bad, p)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(bad) > 0 {
		t.Fatalf("REPLACE INTO board_messages skips the board_message_counts delete trigger; use INSERT/UPDATE in: %v", bad)
	}
}

func TestReplaceCensusRegexpSeesTheSpellings(t *testing.T) {
	re := regexp.MustCompile("(?is)(INSERT\\s+OR\\s+REPLACE|REPLACE)\\s+INTO\\s+[\"`\\[]?board_messages\\b")
	for _, s := range []string{"INSERT OR REPLACE INTO board_messages (a)", "insert  or\nreplace into board_messages", "REPLACE INTO \"board_messages\"", "REPLACE INTO board_messages"} {
		if !re.MatchString(s) {
			t.Errorf("missed %q", s)
		}
	}
	if re.MatchString("INSERT OR REPLACE INTO board_messages_fts (a)") {
		t.Error("matched another table")
	}
}
