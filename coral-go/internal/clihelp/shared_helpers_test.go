package clihelp

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestHasFlagAndWithoutFlag(t *testing.T) {
	args := []string{"detail", "--json", "7", "--json"}
	assert.True(t, HasFlag(args, "--json"))
	assert.False(t, HasFlag(args, "--raw"))
	assert.False(t, HasFlag(nil, "--json"))
	assert.Equal(t, []string{"detail", "7"}, WithoutFlag(args, "--json"), "every copy goes")
	assert.Equal(t, args, WithoutFlag(args, "--raw"))
	assert.Equal(t, []string{}, WithoutFlag(nil, "--json"), "never nil: callers range over it")
	assert.Equal(t, []string{"detail", "--json", "7", "--json"}, args, "the input is not changed")
}

func TestHelpTopicPagesCommandUsageAndUnknown(t *testing.T) {
	usage := func(name string) string {
		if name == "post" {
			return "usage: post"
		}
		return ""
	}
	var w bytes.Buffer
	assert.Equal(t, 0, HelpTopic("coral-board", "windows", &w, usage))
	page, _ := TopicPage("coral-board", "windows")
	assert.Equal(t, page+"\n", w.String())
	w.Reset()
	assert.Equal(t, 0, HelpTopic("coral-board", "post", &w, usage))
	assert.Equal(t, "usage: post\n", w.String())
	w.Reset()
	assert.Equal(t, 2, HelpTopic("coral-board", "nope", &w, usage), "the error goes to stderr, nothing to w")
	assert.Empty(t, w.String())
}
