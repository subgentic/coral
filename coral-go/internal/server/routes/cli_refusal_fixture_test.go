package routes

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #12364: the sentences the server answers for a CLI found and not used are one fixture, tests/frontend/fixtures/cli_refusal_sentences.json, shared with the page's parser (cli_refusal_words.test.mjs).
// Each 'go' case is built here from the server's own code and must equal 'note' exactly: a wording change in the server fails this, one in the page's reading fails the other.
func TestCLIRefusalSentencesMatchTheSharedFixture(t *testing.T) {
	raw, err := os.ReadFile("../../../../tests/frontend/fixtures/cli_refusal_sentences.json")
	require.NoError(t, err)
	var fx struct {
		Cases []struct {
			Name  string `json:"name"`
			Go    string `json:"go"`
			Path  string `json:"path"`
			Agent string `json:"agent"`
			Note  string `json:"note"`
		} `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &fx))
	home, _ := os.UserHomeDir()
	built := 0
	for _, c := range fx.Cases {
		var note string
		switch c.Go {
		case "agent":
			name := c.Agent
			note = cliRefusedNote(c.Path, workingFolderReason(store.LiveSession{AgentName: name, WorkingDir: home}), "cli_path_agy")
		case "temp":
			note = cliRefusedNote(c.Path, refusedInTempFolder, "cli_path_agy")
		case "data":
			note = cliRefusedNote(c.Path, refusedInDataFolder, "cli_path_agy")
		case "tunneled":
			note = cliRefusedNoteTunneled("cli_path_agy")
		default:
			continue // a wording only the page can meet
		}
		built++
		assert.Equal(t, c.Note, note, c.Name)
	}
	assert.GreaterOrEqual(t, built, 4, "the agent, temp, data and Hub sentences are all built here")
}
