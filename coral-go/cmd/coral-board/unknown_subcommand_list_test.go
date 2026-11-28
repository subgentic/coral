package main

import (
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// subcommandCases are the names the top-level "switch sub" of a file runs, without the help spellings.
func subcommandCases(t *testing.T, file string) []string {
	src, err := os.ReadFile(file)
	require.NoError(t, err)
	s := string(src)
	i := strings.Index(s, "\tswitch sub {")
	require.GreaterOrEqual(t, i, 0, file)
	j := strings.Index(s[i:], "\n\tdefault:")
	require.Greater(t, j, 0, file)
	var names []string
	for _, c := range regexp.MustCompile(`(?m)^\tcase ([^\n]*):`).FindAllStringSubmatch(s[i:i+j], -1) {
		for _, n := range regexp.MustCompile(`"([a-z][a-z-]*)"`).FindAllStringSubmatch(c[1], -1) {
			if n[1] != "help" {
				names = append(names, n[1])
			}
		}
	}
	sort.Strings(names)
	return names
}

// An unknown subcommand's error lists the real ones (eval #577: agents guessed task unassign, task read and goal driver). The lists are exactly what the dispatchers run.
func TestTheSubcommandListsMatchTheDispatchers(t *testing.T) {
	for file, list := range map[string][]string{"task.go": taskSubcommands, "goal.go": goalSubcommands} {
		listed := append([]string(nil), list...)
		sort.Strings(listed)
		assert.Equal(t, subcommandCases(t, file), listed, file)
	}
}

func TestAnUnknownSubcommandListsTheRealOnes(t *testing.T) {
	srv := newRecordingServer(t)
	dir := subscribedDataDir(t, srv.URL)
	res := runBoard(t, srv.URL, dir, "task", "unassign")
	assert.Equal(t, 2, res.code, res.stderr)
	assert.Contains(t, res.stderr, "Unknown task subcommand: unassign")
	assert.Contains(t, res.stderr, "The task subcommands are: add, list, show, detail, current, claim, release,")
	res = runBoard(t, srv.URL, dir, "goal", "set-driver")
	assert.Equal(t, 2, res.code, res.stderr)
	assert.Contains(t, res.stderr, "Unknown goal subcommand: set-driver")
	assert.Contains(t, res.stderr, "update, close")
	assert.Contains(t, res.stderr, `coral-board goal update 3 --driver "Agent Name"`)
}
