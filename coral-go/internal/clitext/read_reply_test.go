package clitext

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestReadReplyCleansUnlessRaw(t *testing.T) {
	body := "{\"text\":\"a\\u001b]0;title\\u0007b\"}"
	clean, err := ReadReply(strings.NewReader(body), false)
	assert.NoError(t, err)
	assert.Equal(t, CleanJSON([]byte(body)), clean)
	assert.NotEqual(t, body, string(clean), "terminal control is cleaned")
	raw, err := ReadReply(strings.NewReader(body), true)
	assert.NoError(t, err)
	assert.Equal(t, body, string(raw), "--raw is byte for byte")
}
