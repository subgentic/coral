package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/skills"
)

func boardOptionRefused(stderr string) bool {
	for _, w := range []string{"unknown option", "unknown command", "needs a value", "takes no value", "flag provided but not defined"} {
		if strings.Contains(stderr, w) {
			return true
		}
	}
	return false
}

// #13943: every coral-board command line in the team-builder skill is run against the real command and must not be refused as a usage error; an option the command does not have is caught.
func TestTeamBuilderSkillCoralBoardLinesUseOnlyOptionsTheCommandHas(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error":"no"}`))
	}))
	defer srv.Close()
	ran := 0
	var wait []string
	for _, line := range skills.CLILines(skills.StarterText(skills.TeamBuilderName)) {
		if !strings.HasPrefix(line, "coral-board ") {
			continue
		}
		args := skills.RunnableArgs(line, t.TempDir())
		res := runBoard(t, srv.URL, subscribedDataDir(t, srv.URL), args...)
		assert.False(t, boardOptionRefused(res.stderr), "%q: %s", line, res.stderr)
		if args[0] == "wait" {
			wait = args
		}
		ran++
	}
	require.GreaterOrEqual(t, ran, 3, "the skill shows a status, a wait and a sleep")
	require.NotEmpty(t, wait, "the skill shows the wait")
	res := runBoard(t, srv.URL, subscribedDataDir(t, srv.URL), append(append([]string{}, wait...), "--nope", "x")...)
	assert.True(t, boardOptionRefused(res.stderr), "an invented option is refused: %s", res.stderr)
}
