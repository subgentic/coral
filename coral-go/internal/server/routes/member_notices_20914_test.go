package routes

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/assert"
)

// Security's SHOULD on the #20914 contract: a long Hub address keeps its host first and shows the cut.
func TestAHubHostIsShownFirstAndACutIsMarked(t *testing.T) {
	assert.Equal(t, "hub.example", hubHost("https://hub.example"))
	assert.Equal(t, "hub.example:8443", hubHost("https://hub.example:8443"))
	long := "https://" + strings.Repeat("a", 120) + ".example"
	got := hubHost(long)
	assert.True(t, strings.HasPrefix(got, "aaaa"), "the host comes first, no scheme")
	assert.True(t, strings.HasSuffix(got, "…"), "the cut is marked")
	assert.Equal(t, 81, utf8.RuneCountInString(got))
	assert.Equal(t, "", hubHost(""))
}
