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
