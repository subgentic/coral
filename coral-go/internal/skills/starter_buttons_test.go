package skills

import (
	"regexp"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The Operator (rc4 preview): the Getting started agent asked "What would you like to make? Choices: ..." as a typed list over an empty reply box. A question with a few answers is asked with buttons: the
// single-agent tour with coral-agent ask --option, the team tour with coral-board post --ask --button "LABEL=reply" (or --yes-no), and each says so in one general line.
func TestTheGettingStartedSkillsAskEveryQuestionWithChoicesWithButtons(t *testing.T) {
	read := func(name string) string {
		b, err := starterFS.ReadFile("starter/" + name + "/SKILL.md")
		require.NoError(t, err)
		return string(b)
	}
	agent, team := read("getting-started-agent"), read("getting-started-team")
	for name, md := range map[string]string{"getting-started-agent": agent, "getting-started-team": team} {
		assert.Contains(t, md, "give them as buttons, never as a typed list", name+": the general line")
	}
	assert.Regexp(t, `coral-agent ask "What would you like to make\?"( --option "[^"]+"){3}`, agent, "the 'what would you like to make' step has three short options")
	assert.Contains(t, agent, "click one of the buttons", "the agent tells me to click a button (or type my own)")
	assert.Regexp(t, `coral-board post --ask( --button "[^"=]+=reply"){3} "@Operator What would you like to make\?"`, team, "the team's step has three reply buttons")
	assert.Contains(t, team, "--yes-no", "yes or no questions use --yes-no")
	assert.Regexp(t, `member ask me a practice question with buttons through `+"`"+`coral-board post --ask( --button "[^"=]+=reply")+`, team, "the member's practice question has buttons")
	assert.NotRegexp(t, regexp.MustCompile(`coral-board post --ask "@Operator What would you like to make`), team, "no bare question with choices left")
	assert.NotRegexp(t, regexp.MustCompile(`coral-agent ask "What would you like to make\?"\.`), agent, "no bare question with choices left")
}

// The Operator (rc4c preview): the agent used buttons for the first question only; every later step ended in plain chat ("Tell me when you've finished"). Every step that waits on the person ends with
// buttons (Done / Skip this step / Stop the tour), and the file review step says where Approve and Request changes are.
func TestEveryStepOfTheGettingStartedSkillsThatWaitsEndsWithButtons(t *testing.T) {
	read := func(name string) string {
		b, err := starterFS.ReadFile("starter/" + name + "/SKILL.md")
		require.NoError(t, err)
		return string(b)
	}
	agent, team := read("getting-started-agent"), read("getting-started-team")
	assert.Regexp(t, `Every step that waits on me ends with buttons too, never plain chat.*`+"`"+`coral-agent ask "[^"]+"( --option "(Done|Skip this step|Stop the tour)"){3}`+"`", agent, "the agent's general wait rule names the button command with all three buttons")
	assert.Regexp(t, `Every step that waits on me ends with buttons too, never plain chat.*`+"`"+`coral-board post --ask( --button "(Done|Skip this step|Stop the tour)=reply"){3} "@Operator [^"]+"`+"`", team, "the team's general wait rule names the button command with all three buttons")
	assert.Contains(t, agent, "Approve and Request changes buttons are on the file itself", "the agent says where the review buttons are")
	assert.Contains(t, team, "those buttons are on the file itself", "the team's Orchestrator says where the review buttons are")
	// every step that waits has the three buttons named in it, not just in the general line
	assert.Contains(t, agent, "after each, ask with the Done / Skip this step / Stop the tour buttons", "the Analytics and Settings steps wait with buttons")
	for _, step := range []string{"one at a time, ending each with the Done / Skip this step / Stop the tour buttons", "end the step with the Done / Skip this step / Stop the tour buttons"} {
		assert.Contains(t, team, step, "a waiting team step ends with the buttons")
	}
	assert.NotRegexp(t, `(?i)tell me when you('ve| have) finished`, agent+team, "no plain-chat wait left")
}

// The Operator (rc4c preview): as the tour does each thing, the guide says in one line how to get any agent to do it again.
func TestTheGettingStartedSkillsSayHowToGetAnyAgentToDoItAgain(t *testing.T) {
	read := func(name string) string {
		b, err := starterFS.ReadFile("starter/" + name + "/SKILL.md")
		require.NoError(t, err)
		return string(b)
	}
	agent, team := read("getting-started-agent"), read("getting-started-team")
	assert.Contains(t, agent, "ask it to ask me with buttons, and it will use `coral-agent ask --option`", "agent: buttons")
	assert.Contains(t, team, "ask any agent to ask me with buttons, and it will use `coral-board post --ask --button`", "team: buttons")
	for name, md := range map[string]string{"agent": agent, "team": team} {
		assert.Contains(t, md, "put a file in Needs you for review", name+": Needs you")
		assert.Contains(t, md, "`coral-agent artifact upload <file> --tag \"for review\"`", name+": the upload command")
		assert.Contains(t, md, "read my comments", name+": a comment")
		assert.Contains(t, md, "answer Send to agent", name+": Send to agent")
		assert.Contains(t, md, "upload it as a new version", name+": --new-version-of")
	}
}

// The Operator (#18766): the first sample file the tour sends has a picture in it, in the one form the preview draws (a data: image, which Coral's Markdown keeps), and each stop of the single-agent
// tour says in plain words where the place is, what it is for, what the person will see and what to try.
func TestTheGettingStartedSkillsSendASampleFileWithAnImageAndExplainEachStop(t *testing.T) {
	read := func(name string) string {
		b, err := starterFS.ReadFile("starter/" + name + "/SKILL.md")
		require.NoError(t, err)
		return string(b)
	}
	agent, team := read("getting-started-agent"), read("getting-started-team")
	for name, md := range map[string]string{"agent": agent, "team": team} {
		assert.Contains(t, md, "![A small chart](data:image/svg+xml;base64,<the base64 text>)", name+": the form of the embedded image")
		assert.Contains(t, md, "nothing downloaded", name+": the image is made for the sample")
	}
	assert.Contains(t, agent, "the first file you send must include at least one image", "the first file has an image")
	assert.Contains(t, agent, "ask any agent to put an image in the file it sends me", "how to get any agent to do it again")
	for _, where := range []string{"the Inbox tab at the top left", "the Analytics tab in the row of tabs along the top", "the gear icon at the top right"} {
		assert.Contains(t, agent, where, "the agent says where the page is")
	}
	assert.Contains(t, agent, "what it is for", "the agent explains what a place is for")
	assert.Contains(t, agent, "what I will see", "the agent says what the person will see")
	assert.Contains(t, agent, "what to try", "the agent says what to try")
	assert.Contains(t, team, "the Inbox tab at the top left", "the team's Orchestrator says where Needs you is")
}
