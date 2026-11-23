package routes

import (
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/assert"
)

// QA's SHOULD on #20883: a label is cut by characters, never in the middle of one.
func TestACappedLabelIsNeverSplitInTheMiddleOfACharacter(t *testing.T) {
	long := ""
	for i := 0; i < 60; i++ {
		long += "é" // two bytes each
	}
	got := capLabel(long, 40)
	assert.True(t, utf8.ValidString(got))
	assert.Equal(t, 40, utf8.RuneCountInString(got))
	assert.Equal(t, "short", capLabel("short", 40))
	assert.Equal(t, "", capLabel("", 40))
}
