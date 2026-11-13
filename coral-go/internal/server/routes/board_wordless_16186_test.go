package routes

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/clitext"
)

// #16186: the server refuses a post with no words (a bare "-", only mentions) on every path in, so a CLI that sends one, an HTTP client or the Hub cannot put an empty card in Needs you.
func TestAPostWithNoWordsIsRefusedByTheServer(t *testing.T) {
	post, count, _, _ := buttonRig(t)
	before := count()
	for _, c := range []struct {
		text string
		ask  bool
	}{{"@Operator -", true}, {"@Operator -", false}, {"@Operator", true}, {"-", false}, {"* \n- \n", false}} {
		status, body := post(map[string]any{"subscriber_id": "Lead", "content": c.text, "ask": c.ask})
		assert.Equal(t, http.StatusBadRequest, status, "%q ask=%v: %v", c.text, c.ask, body)
		assert.Equal(t, clitext.WordlessGuidance, body["error"], c.text)
	}
	assert.Equal(t, before, count(), "nothing was stored")
	status, body := post(map[string]any{"subscriber_id": "Lead", "content": "@Operator - ship it?", "ask": true})
	require.Equal(t, http.StatusOK, status, body)
}
