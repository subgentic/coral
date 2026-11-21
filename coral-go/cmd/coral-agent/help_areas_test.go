package main

import (
	"bytes"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/clihelp"
)

// #20399: the help overview and the area pages cannot drift from the commands.
func TestEveryAgentCommandIsInExactlyOneArea(t *testing.T) {
	seen := map[string]string{}
	for _, a := range agentAreas {
		for _, c := range a.Commands {
			assert.True(t, commands[c], "area %s lists %q, which is not a coral-agent command", a.Name, c)
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
	assert.Empty(t, missing, "commands in no help area: add each to agentAreas")
}

func docExists(t *testing.T, topic string) bool {
	t.Helper()
	_, err := os.Stat(filepath.Join("..", "..", "agent_docs", topic+".md"))
	return err == nil
}

func TestAgentAreaMoreGuidesExist(t *testing.T) {
	for _, a := range agentAreas {
		assert.NotEmpty(t, a.More, a.Name)
		for _, m := range a.More {
			assert.True(t, docExists(t, m), "area %s: more: coral-agent docs %s, but agent_docs/%s.md does not exist", a.Name, m, m)
		}
	}
}

func TestAgentOverviewIsOneScreenAndLinksEveryArea(t *testing.T) {
	out := clihelp.Overview("coral-agent", agentOther, agentAreas)
	assert.LessOrEqual(t, strings.Count(out, "\n"), 30, "one screen")
	for _, a := range agentAreas {
		assert.Contains(t, out, "(coral-agent help "+a.Name+")")
	}
	assert.Contains(t, out, "coral-board help overview", "points at the other tool")
}

func TestHelpOverviewAndAreaThroughHandleHelp(t *testing.T) {
	var w bytes.Buffer
	handled, code := handleHelp([]string{"help", "overview"}, &w)
	assert.True(t, handled)
	assert.Zero(t, code)
	assert.Contains(t, w.String(), "coral-agent help overview")
	w.Reset()
	handled, _ = handleHelp([]string{"help", "artifacts"}, &w)
	assert.True(t, handled)
	assert.Contains(t, w.String(), "artifact review")
	w.Reset()
	handled, _ = handleHelp([]string{"--help"}, &w)
	assert.True(t, handled)
	assert.True(t, strings.HasPrefix(w.String(), "coral-agent help overview"), "bare help starts with the overview")
	assert.Contains(t, w.String(), "coral-agent - launch Coral agents")
	w.Reset()
	handled, _ = handleHelp([]string{"help", "skills"}, &w) // an area that is also a command shows both
	assert.True(t, handled)
	assert.Contains(t, w.String(), "The command itself:")
}
