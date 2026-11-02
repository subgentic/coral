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

// #12352 (coral-hub's report): "no mention has reached X" flagged a member whose name has a shorter member's name as its start (A = "Security Reviewer", B = "Security Reviewer Distributed Systems": every
// "@Security Reviewer" flagged B). Each @ is resolved to the longest member name it fully matches, as delivery does; a start of a name counts as an address only when no member's whole name matches there.
func TestMentionGapResolvesAMentionToTheLongestMemberNameItFullyMatches(t *testing.T) {
	members := []string{"Security Reviewer", "Security Reviewer Distributed Systems", "Security", "Backend Dev"}
	gap := func(name string, posts ...RecentPost) int {
		n, _ := MentionGapAmong(name, "", members, posts)
		return n
	}
	// the reported case: A's full name, a few times, from others: nobody else is flagged for it
	posts := []RecentPost{
		post("Orchestrator", "@Security Reviewer please read #12", 5*time.Minute),
		post("QA", "@Security Reviewer: and this", 20*time.Minute),
		post("Orchestrator", "@Security Reviewer ping", 2*time.Minute),
	}
	assert.Zero(t, gap("Security Reviewer Distributed Systems", posts...), "B is not flagged for mentions of A")
	assert.Zero(t, gap("Security", posts...), "nor 'Security', whose whole name is a start of A's: the mention is A's")
	assert.Zero(t, gap("Security Reviewer", posts...), "A was reached")

	// B's own full name is B's, and not A's or Security's
	b := []RecentPost{post("QA", "@Security Reviewer Distributed Systems go", time.Minute)}
	assert.Zero(t, gap("Security Reviewer Distributed Systems", b...))
	assert.Zero(t, gap("Security Reviewer", b...), "longest wins: not a try for A either")

	// longest wins also for "reached": the longer member's mention does not stand in for a mention of the shorter one, so a real partial address of A stays a gap beside it
	both := []RecentPost{post("QA", "@Secur look at this", 4*time.Minute), post("QA", "@Security Reviewer Distributed Systems go", time.Minute)}
	assert.Equal(t, 1, gap("Security Reviewer", both...), "B's mention did not reach A, so the '@Secur' try stands")
	assert.Zero(t, gap("Security Reviewer Distributed Systems", both...), "B was reached")

	// a start of a name that no member's whole name matches is still a gap, as before
	partial := []RecentPost{post("Orchestrator", "@Backen look at this", 3*time.Minute), post("QA", "@Backen again", 8*time.Minute)}
	assert.Equal(t, 2, gap("Backend Dev", partial...))
	n, oldest := MentionGapAmong("Backend Dev", "", members, partial)
	assert.Equal(t, 2, n)
	assert.Equal(t, partial[1].At, oldest)
	// a proper mention in the window still means it reached
	assert.Zero(t, gap("Backend Dev", append(partial, post("QA", "@Backend Dev ok", time.Minute))...))
	// with no other member's name known it is MentionGap
	n, _ = MentionGapAmong("Backend Dev", "", nil, partial)
	m, _ := MentionGap("Backend Dev", "", partial)
	assert.Equal(t, m, n)
}

// QA's three pins on #12352: where a name ends. A mention is a whole name only when the next character does not continue a word (a letter, a digit, "_" or "-"), and a member is also reached by its job title.
func TestMentionGapNameBoundariesAndJobTitles(t *testing.T) {
	members := []string{"Alice", "Bob Builder", "Dev One", "Developer", "Developer Operations", "Ops"}
	try := post("QA", "@Ali take a look", 5*time.Minute) // a real partial address of Alice: a gap until a proper mention comes
	gapOf := func(name, title string, posts ...RecentPost) int {
		n, _ := MentionGapAmong(name, title, members, posts)
		return n
	}
	assert.Equal(t, 1, gapOf("Alice", "", try), "the partial alone is a gap")

	// '@Alice2' is another word (a digit continues it), not a mention of Alice: it does not clear the gap
	assert.Equal(t, 1, gapOf("Alice", "", try, post("QA", "@Alice2 hello", time.Minute)), "a digit continues the word")
	// nor does a hyphen
	assert.Equal(t, 1, gapOf("Alice", "", try, post("QA", "@Alice-Bob hello", time.Minute)), "a hyphen continues the word")
	assert.Equal(t, 1, gapOf("Alice", "", try, post("QA", "@Alice_2 hello", time.Minute)), "so does an underscore")
	// punctuation, a space or the end of the text ends the name: those are mentions
	for _, ok := range []string{"@Alice, hello", "@Alice: hello", "@Alice hello", "@Alice", "@Alice."} {
		assert.Zero(t, gapOf("Alice", "", try, post("QA", ok, time.Minute)), ok)
	}

	// a member is reached by its job title: "Dev One" (title "Developer") by "@Developer", which is not "Developer Operations"' whole name
	devTry := post("QA", "@Dev look at this", 5*time.Minute)
	assert.Equal(t, 1, gapOf("Dev One", "Developer", devTry), "the partial alone is a gap")
	assert.Zero(t, gapOf("Dev One", "Developer", devTry, post("QA", "@Developer please read #12", time.Minute)), "reached by its job title")
	assert.Equal(t, 1, gapOf("Dev One", "", devTry, post("QA", "@Developer please read #12", time.Minute)), "without the title the same mention is not its own")
	// and the longer member whose id starts with that title is its own: "@Developer Operations" is not a mention of "Dev One" by its title
	assert.Equal(t, 1, gapOf("Dev One", "Developer", devTry, post("QA", "@Developer Operations deploy", time.Minute)), "longest wins over the title")
	assert.Zero(t, gapOf("Developer Operations", "Ops", post("QA", "@Developer Operations deploy", time.Minute)), "it reached Developer Operations")
}
