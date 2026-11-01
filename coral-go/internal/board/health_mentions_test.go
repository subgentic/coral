package board

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func post(sender, content string, ago time.Duration) RecentPost {
	return RecentPost{Sender: sender, Content: content, At: time.Date(2026, 11, 1, 8, 0, 0, 0, time.UTC).Add(-ago)}
}

// Rule 4 (#11729): posts that @-address a part of a name, with no proper mention of it, are a gap; a proper mention anywhere in the window means it reached.
func TestMentionGapCountsPostsThatAddressAPrefixOnly(t *testing.T) {
	posts := []RecentPost{
		post("Orchestrator", "@Backend please look at #12", 5*time.Minute),
		post("QA", "thanks @backend, any news?", 20*time.Minute),
		post("Orchestrator", "@Frontend Dev ship it", 2*time.Minute),
	}
	n, oldest := MentionGap("Backend Dev", "Backend Developer", posts)
	assert.Equal(t, 2, n)
	assert.Equal(t, posts[1].At, oldest, "the oldest try")
	// a proper mention anywhere in the window: it reached
	n, _ = MentionGap("Backend Dev", "Backend Developer", append(posts, post("QA", "@Backend Dev one more", time.Minute)))
	assert.Zero(t, n)
	// by its job title too
	n, _ = MentionGap("Backend Dev", "Backend Developer", append(posts, post("QA", "@Backend Developer: hello", time.Minute)))
	assert.Zero(t, n)
	// its own posts never count, and a prefix shorter than three characters is not an address
	n, _ = MentionGap("Backend Dev", "", []RecentPost{post("Backend Dev", "@Backend Dev notes to self @Back", time.Minute), post("QA", "@Ba hi", time.Minute)})
	assert.Zero(t, n)
	// another name that only starts the same way is not a try for this one
	n, _ = MentionGap("Backend Dev", "", []RecentPost{post("QA", "@Backups are failing", time.Minute)})
	assert.Zero(t, n, "'@Backups' is another word, not the start of 'Backend Dev'")
	// the whole name followed by more is a proper mention (mentionedNames decides)
	n, _ = MentionGap("Backend Dev", "", []RecentPost{post("QA", "@Backend Dev 2 take this", time.Minute)})
	assert.Zero(t, n)
}

func TestNameHasEdgePunctuation(t *testing.T) {
	for name, want := range map[string]bool{
		"Backend Dev": false, "Dev 2": false, "Équipe": false, "": false,
		"Dev (night)": false, "QA (2)": false, "Writer [docs]": false, // a closing bracket may end a name (#11687)
		".Dev": true, "Dev:": true, "(QA)": true, "@Dev": true, "Dev-": true, "Reviewer 2:": true, "  Dev. ": true, "Dev,": true, `Dev"`: true,
	} {
		assert.Equal(t, want, NameHasEdgePunctuation(name), name)
	}
}
