package routes

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11097: a row's last_message is the first 140 characters of the text, redacted like an excerpt, with the role and the time.
func TestLastMessageFieldIsCutAndRedacted(t *testing.T) {
	assert.Nil(t, lastMessageField(nil, false), "no message: the field is null")

	long := strings.Repeat("word ", 100)
	f := lastMessageField(&lastMessageSource{Role: "assistant", Text: long, At: "2026-10-29T10:00:00Z"}, false)
	require.NotNil(t, f)
	assert.Equal(t, "assistant", f["role"])
	assert.Equal(t, "2026-10-29T10:00:00Z", f["at"])
	assert.Len(t, []rune(f["text"].(string)), 140, "the first 140 characters")

	multi := strings.Repeat("é", 300)
	f = lastMessageField(&lastMessageSource{Role: "user", Text: multi}, false)
	assert.Equal(t, strings.Repeat("é", 140), f["text"], "cut by characters, never in the middle of one")

	key := "sk-ant-api03-" + strings.Repeat("aB3_x9Z-", 11) + "AA" // the shape of an Anthropic key
	f = lastMessageField(&lastMessageSource{Role: "user", Text: "my key is " + key + " ok"}, false)
	assert.NotContains(t, f["text"], key, "a secret is redacted before it leaves, as in an excerpt")
	assert.NotContains(t, f["text"], "aB3_x9Z-aB3_x9Z-", "none of it")
}
