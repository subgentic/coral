package routes

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #16038: the excerpt of a message is redacted whole, then cut: a secret that straddles the cut (ending at character 140, or just before or after it) is never stored as a fragment the redactor would not know.
func TestAFirstLineSecretAtTheCutIsRedactedWholeNotStoredAsAFragment(t *testing.T) {
	secrets := map[string]string{
		"a GitHub token":   "ghp_" + strings.Repeat("aB3dE5gH7j", 3) + "kLmNoP",
		"an Anthropic key": "sk-ant-api03-" + strings.Repeat("Zx9Qw8Er7T", 4),
	}
	for name, secret := range secrets {
		for end := 130; end <= 150; end++ { // the token's last character lands at 130..150
			line := strings.Repeat("x", end-len(secret)-1) + " " + secret + " tail words after it"
			got := firstLineExcerpt(line)
			for i := 0; i+12 <= len(secret); i++ { // 12 characters of it anywhere is a fragment
				assert.NotContains(t, got, secret[i:i+12], "%s ending at %d: a fragment of it is stored", name, end)
			}
		}
	}
	assert.Equal(t, "hello there", firstLineExcerpt("\n  hello there\nsecond"))
	assert.LessOrEqual(t, len([]rune(firstLineExcerpt(strings.Repeat("a b ", 100)))), 141)
}
