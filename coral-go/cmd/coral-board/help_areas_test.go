package main

import (
	"bytes"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clihelp"
)

// #20399: the help overview and the area pages cannot drift from the commands.
func TestEveryBoardCommandIsInExactlyOneArea(t *testing.T) {
	seen := map[string]string{}
	for _, a := range boardAreas {
		for _, c := range a.Commands {
			assert.True(t, commands[c], "area %s lists %q, which is not a coral-board command", a.Name, c)
			if prev, dup := seen[c]; dup {
				t.Errorf("command %q is in two areas: %s and %s", c, prev, a.Name)
			}
			seen[c] = a.Name
		}
	}
	var missing []string
	for c := range commands {
		if _, ok := seen[c]; !ok {
			missing = append(missing, c)
		}
	}
	sort.Strings(missing)
	assert.Empty(t, missing, "commands in no help area: add each to boardAreas")
}

func docExists(t *testing.T, topic string) bool {
	t.Helper()
	_, err := os.Stat(filepath.Join("..", "..", "agent_docs", topic+".md"))
	return err == nil
}

func TestBoardAreaMoreGuidesExist(t *testing.T) {
	for _, a := range boardAreas {
		assert.NotEmpty(t, a.More, a.Name)
		for _, m := range a.More {
			assert.True(t, docExists(t, m), "area %s: more: coral-agent docs %s, but agent_docs/%s.md does not exist", a.Name, m, m)
		}
	}
}

func TestBoardOverviewIsOneScreenAndLinksEveryArea(t *testing.T) {
	out := clihelp.Overview("coral-board", boardOther, boardAreas)
	assert.LessOrEqual(t, strings.Count(out, "\n"), 30, "one screen")
	for _, a := range boardAreas {
		assert.Contains(t, out, "(coral-board help "+a.Name+")")
	}
	assert.Contains(t, out, "coral-agent help overview", "points at the other tool")
}

// the health page names every rule group the settings table has, so a new rule is added to the help with it
func TestHealthHelpNamesEveryRuleGroupOfTheSettingsTable(t *testing.T) {
	var page bytes.Buffer
	require.True(t, clihelp.HelpAreas("coral-board", boardOther, "health", boardAreas, func(string) string { return "" }, &page))
	for _, k := range board.HealthKeys(board.DefaultHealthSettings()) {
		group := strings.SplitN(k.Key, ".", 2)[0]
		assert.Contains(t, page.String(), group, "health help does not name the rule group of %s: add it to healthRules", k.Key)
	}
}

func TestHelpOverviewAndAreaThroughHandleHelp(t *testing.T) {
	var w bytes.Buffer
	handled, code := handleHelp([]string{"help", "overview"}, &w)
	assert.True(t, handled)
	assert.Zero(t, code)
	assert.Contains(t, w.String(), "coral-board help overview")
	w.Reset()
	handled, _ = handleHelp([]string{"help", "questions"}, &w)
	assert.True(t, handled)
	assert.Contains(t, w.String(), "--yes-no")
	w.Reset()
	handled, _ = handleHelp([]string{"--help"}, &w)
	assert.True(t, handled)
	assert.True(t, strings.HasPrefix(w.String(), "coral-board help overview"), "bare help starts with the overview")
	assert.Contains(t, w.String(), "Usage: coral-board <command>")
	w.Reset()
	handled, _ = handleHelp([]string{"help", "search"}, &w) // an area that is also a command shows both
	assert.True(t, handled)
	assert.Contains(t, w.String(), "coral-board help search")
	assert.Contains(t, w.String(), "The command itself:")
}
