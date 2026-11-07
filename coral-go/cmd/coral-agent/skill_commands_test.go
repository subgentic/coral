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

// usageError is how the commands refuse an option they do not have (the words of internal/clihelp and of the commands' own parsers).
func skillLineRefused(stderr string) bool {
	for _, w := range []string{"unknown option", "unknown command", "needs a value", "takes no value", "flag provided but not defined"} {
		if strings.Contains(stderr, w) {
			return true
		}
	}
	return false
}

// #13943: the Operator's no-invented-flags rule for the skills Coral ships, enforced: every coral-agent command line in the team-builder skill is run against the real command (a server that answers 404 to
// everything, so nothing else can fail first) and must not be refused as a usage error; an option the command does not have is caught (the mutant: --thinking, which launch does not take).
func TestTeamBuilderSkillCoralAgentLinesUseOnlyOptionsTheCommandHas(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error":"no"}`))
	}))
	defer srv.Close()
	md := skills.StarterText(skills.TeamBuilderName)
	ran := 0
	var launch []string
	for _, line := range skills.CLILines(md) {
		if !strings.HasPrefix(line, "coral-agent ") {
			continue
		}
		args := skills.RunnableArgs(line, t.TempDir())
		_, _, stderr := runAgent(t, srv.URL, args...)
		assert.False(t, skillLineRefused(stderr), "%q: %s", line, stderr)
		if args[0] == "launch" {
			launch = args
		}
		ran++
	}
	require.GreaterOrEqual(t, ran, 2, "the skill shows a launch and an upload")
	require.NotEmpty(t, launch, "the skill shows a launch line")

	_, _, stderr := runAgent(t, srv.URL, append(append([]string{}, launch...), "--thinking", "high")...)
	assert.True(t, skillLineRefused(stderr), "an invented option is refused: %s", stderr)

	// options the skill names on their own are options of launch or of upload
	for _, f := range skills.FlagSpans(md) {
		_, _, a := runAgent(t, srv.URL, "launch", t.TempDir(), f, "x")
		_, _, b := runAgent(t, srv.URL, "artifact", "upload", "x.md", f, "x")
		assert.False(t, skillLineRefused(a) && skillLineRefused(b), "%s is an option of neither launch nor upload", f)
	}
}
