package board

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseAskButtonGrammar(t *testing.T) {
	d := strings.Repeat("ab", 32)
	for raw, want := range map[string]AskButton{
		"Yes, ship it=reply":                            {Label: "Yes, ship it", Action: ActionReply},
		"New agent=open:new-agent":                      {Label: "New agent", Action: ActionOpenNewAgent},
		"The task=open:task:12":                         {Label: "The task", Action: ActionOpenTask, Arg: "12"},
		"The plan=open:artifact:" + strings.ToUpper(d):  {Label: "The plan", Action: ActionOpenArtifact, Arg: d},
		"The plan=open:artifact:coral://artifacts/" + d: {Label: "The plan", Action: ActionOpenArtifact, Arg: d},
		"Wake Dev=wake:Dev A":                           {Label: "Wake Dev", Action: ActionWake, Arg: "Dev A"},
	} {
		b, err := ParseAskButton(1, raw, nil)
		require.NoError(t, err, raw)
		assert.Equal(t, want.Label, b.Label, raw)
		assert.Equal(t, want.Action, b.Action, raw)
		assert.Equal(t, want.Arg, b.Arg, raw)
		assert.Equal(t, ButtonPending, b.State)
	}
	for raw, why := range map[string]string{
		"no equals sign":                   "Label=action",
		"=reply":                           "label is empty",
		strings.Repeat("x", 33) + "=reply": "longer than 32",
		"Yes‮no=reply":                     "hidden or control",
		"Yes\x1b[31m=reply":                "hidden or control",
		"Yes​no=reply":                     "hidden or control",
		"Tell @Dev=reply":                  "an @",
		"See https://x.test=reply":         "link",
		"See coral://x=reply":              "link",
		"Go=open":                          "action must be",
		"Go=reply:now":                     "action must be",
		"Go=open:task:abc":                 "task number",
		"Go=open:task:0":                   "task number",
		"Go=open:artifact:abc":             "64-character",
		"Go=wake:":                         "member",
		"Go=wake:../x\n":                   "member",
		"Go=run:rm -rf /":                  "action must be",
		"Go=open:url:https://x.test":       "action must be",
	} {
		_, err := ParseAskButton(2, raw, nil)
		require.Error(t, err, raw)
		assert.Contains(t, err.Error(), why, raw)
		assert.Contains(t, err.Error(), "button 2", "it names the button")
	}
	_, err := ParseAskButton(1, "Open it=reply", func(string) bool { return true })
	assert.Error(t, err, "a sign-in link in a label is refused")
}

func TestParseAskButtonsCapsAndDuplicates(t *testing.T) {
	_, err := ParseAskButtons([]string{"A=reply", "B=reply", "C=reply", "D=reply"}, nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "at most 3")
	_, err = ParseAskButtons([]string{"Yes=reply", "yes=open:new-agent"}, nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "same label")
	out, err := ParseAskButtons([]string{"A=reply", "B=open:new-agent", "C=open:task:3"}, nil)
	require.NoError(t, err)
	require.Len(t, out, 3)
	assert.Equal(t, []int{1, 2, 3}, []int{out[0].Pos, out[1].Pos, out[2].Pos})
	_, err = ParseAskButtons([]string{"A=reply", "bad"}, nil)
	assert.Error(t, err, "one bad button refuses all")
}
