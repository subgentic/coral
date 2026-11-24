package board

import (
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// Brief task 7 (#21056): two built-in templates for a person working alone, Overnight run and Builder and reviewer. They are dashboard data (team_templates_ui.js), so this reads
// the source. The Overnight run carries a morning-summary reminder on its Orchestrator (#21019), the Builder and reviewer's reviewer is another vendor's agent, each has the
// two-line description the card shows (#21023), and the dialog hands a role's reminders to the launch.

func templateBlock(t *testing.T, src, name string) string {
	t.Helper()
	start := strings.Index(src, `name: "`+name+`"`)
	require.True(t, start >= 0, "the %s template is built in", name)
	rest := src[start+1:]
	end := strings.Index(rest, "\n    },")
	require.True(t, end > 0)
	return src[start : start+1+end]
}

func TestOvernightRunTemplateCarriesAMorningSummaryReminder(t *testing.T) {
	block := templateBlock(t, frontendSource(t, "team_templates_ui.js"), "Overnight run")
	require.Equal(t, []string{"Orchestrator", "Builder", "Checker"}, memberNames(block), "the Orchestrator plans, a builder builds, a checker checks")
	require.Regexp(t, `reminders: \[\{ text: "[^"]*[Mm]orning summary[^"]*Needs you[^"]*", kind: "daily", at: "0[5-9]:[0-5][0-9]" \}\]`, block, "a morning summary to Needs you, every day, early")
	require.Equal(t, 1, strings.Count(block, "reminders:"), "on one role: the Orchestrator's")
	require.Less(t, strings.Index(block, "reminders:"), strings.Index(block, `name: "Builder"`), "the Orchestrator's, the first member")
	requireTwoLineDescription(t, block)
	require.NotRegexp(t, `\bmode: "`, block, "no working mode of its own")
}

func TestBuilderAndReviewerTemplateHasAReviewerFromAnotherVendor(t *testing.T) {
	block := templateBlock(t, frontendSource(t, "team_templates_ui.js"), "Builder and reviewer")
	require.Equal(t, []string{"Orchestrator", "Builder", "Reviewer"}, memberNames(block))
	types := map[string]string{}
	for _, m := range regexp.MustCompile(`name: "([^"]+)", agent_type: "([a-z]+)"`).FindAllStringSubmatch(block, -1) {
		types[m[1]] = m[2]
	}
	require.Equal(t, "claude", types["Builder"])
	require.NotEmpty(t, types["Reviewer"], "the reviewer names its vendor")
	require.NotEqual(t, types["Builder"], types["Reviewer"], "a reviewer of another vendor than the builder")
	require.Contains(t, block, "approve", "every change waits for the person's approve")
	requireTwoLineDescription(t, block)
	require.NotContains(t, block, "reminders:")
}

func TestTheDialogHandsATemplateRolesRemindersToTheLaunch(t *testing.T) {
	dialogs := frontendSource(t, "team_dialogs.js")
	require.Contains(t, dialogs, "reminders: agent.reminders", "loading a template keeps each role's reminders on its row")
	require.Contains(t, dialogs, "agent.reminders = ", "the launch request carries them")
}

func memberNames(block string) []string {
	names := []string{}
	for _, m := range regexp.MustCompile(`\{ name: "([^"]+)", `).FindAllStringSubmatch(block, -1) {
		names = append(names, m[1])
	}
	return names
}

// requireTwoLineDescription: the card's text is two lines, what the team does then what the person does (#21023).
func requireTwoLineDescription(t *testing.T, block string) {
	t.Helper()
	m := regexp.MustCompile(`does: "([^"]+)", you: "([^"]+)"`).FindStringSubmatch(block)
	require.NotNil(t, m, "two lines, as the tiles read them: does (what the team does) and you (what you do)")
	require.Regexp(t, `^You `, m[2], "the second line is what you do")
}

// Brief task 8 (#21058): the next three solo templates. Each has an Orchestrator (the Members step needs one) and two roles named by what they do, two lines for its card, and no
// working mode; Bug sweep carries its reminder on the Orchestrator; Docs and tests catch-up and Research and write-up have none (the weekly one waits for the weekly kind, #21085).
func TestTheNextThreeSoloTemplates(t *testing.T) {
	src := frontendSource(t, "team_templates_ui.js")
	for _, c := range []struct {
		name     string
		members  []string
		reminder string // a pattern for the one reminder, "" for none
	}{
		{"Bug sweep", []string{"Orchestrator", "Reproducer", "Fixer"}, `text: "Daily summary: [^"]*Needs you[^"]*", kind: "daily", at: "[0-2][0-9]:[0-5][0-9]"`},
		{"Docs and tests catch-up", []string{"Orchestrator", "Test Writer", "Docs Writer"}, ""}, // no reminder yet: a weekly Monday one comes with the weekly reminder kind (#21085)
		{"Research and write-up", []string{"Orchestrator", "Researcher", "Writer"}, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			block := templateBlock(t, src, c.name)
			require.Equal(t, c.members, memberNames(block))
			requireTwoLineDescription(t, block)
			require.NotRegexp(t, `\bmode: "`, block)
			if c.reminder == "" {
				require.NotContains(t, block, "reminders:")
				if c.name == "Research and write-up" {
					require.Contains(t, block, "review", "the report goes to the person for review")
				}
				return
			}
			require.Equal(t, 1, strings.Count(block, "reminders:"))
			require.Regexp(t, `reminders: \[\{ `+c.reminder+` \}\]`, block)
			require.Less(t, strings.Index(block, "reminders:"), strings.Index(block, `name: "`+c.members[1]+`"`), "the Orchestrator's")
		})
	}
}
