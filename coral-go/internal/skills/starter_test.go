package skills

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The example skills Coral ships (#12463): three, each a valid skill that an agent could publish (Markdown only), named like its folder, the same bytes on every build.
func TestTheStarterSkillsAreValidMarkdownOnlyAndStable(t *testing.T) {
	a, err := StarterZips()
	require.NoError(t, err)
	var names []string
	for _, z := range a {
		names = append(names, z.Name)
		sk, err := Parse(z.Data)
		require.NoError(t, err, z.Name)
		assert.Equal(t, z.Name, sk.Name, "the skill is named like its folder")
		assert.True(t, AgentMayPublish(sk), "%s holds only what an agent's skill may", z.Name)
		assert.Zero(t, sk.Scripts(), z.Name)
		assert.Zero(t, sk.NotReviewable(), z.Name)
		assert.Len(t, sk.Files, 1, "SKILL.md alone")
		assert.NotContains(t, sk.Description, "\n", z.Name)
		assert.True(t, strings.HasPrefix(sk.Description, "How"), "%s: a description that says what it is for", z.Name)
	}
	assert.Equal(t, []string{"creating-a-coral-automation", "creating-coral-skills", "using-coral", "working-in-a-coral-team"}, names)
	b, err := StarterZips()
	require.NoError(t, err)
	for i := range a {
		assert.Equal(t, a[i].Data, b[i].Data, "the same bytes each time, so the digest changes only with the text")
	}
}

// #13523: the using-coral starter skill is the one text every agent's launch carries a short part of, so a plain agent (not on a team) is told what Coral gives it. The launch part is the marked region of the skill's own
// file: one text, no copy to drift. It is a screenful at most, names no task number, and every coral-agent command either text names is one coral-agent has.
func TestUsingCoralIsTheLaunchTextAndTheSkillAtOnce(t *testing.T) {
	md, err := starterFS.ReadFile("starter/using-coral/SKILL.md")
	require.NoError(t, err)
	section := LaunchSection()
	require.NotEmpty(t, section, "the skill has no launch region")
	assert.Contains(t, string(md), section, "the launch text is the skill's own text")
	assert.LessOrEqual(t, len(strings.Split(section, "\n")), 14, "a screenful at most: the agent reads it at every launch")
	assert.LessOrEqual(t, len(section), 2200)
	assert.NotRegexp(t, `#\d{3,}`, string(md), "no task numbers in what an agent reads")
	for _, want := range []string{"coral-agent skills search", "coral-agent artifact upload", "coral://artifacts/<digest>", "coral-agent notify", "coral-agent task", "coral-board post --ask"} {
		assert.Contains(t, section, want)
	}
	assert.Contains(t, section, "using-coral", "the launch text names the skill that has the rest")
}

func TestEveryCoralAgentCommandTheUsingCoralSkillNamesExists(t *testing.T) {
	usage := ""
	for _, f := range []string{"main.go", "skills.go", "history.go", "docs.go"} {
		b, err := os.ReadFile(filepath.Join("..", "..", "cmd", "coral-agent", f))
		require.NoError(t, err)
		usage += string(b)
	}
	md, err := starterFS.ReadFile("starter/using-coral/SKILL.md")
	require.NoError(t, err)
	re := regexp.MustCompile("coral-agent ([a-z]+)(?: ([a-z]+(?:\\|[a-z]+)*))?")
	for _, m := range re.FindAllStringSubmatch(string(md), -1) {
		first := m[1]
		if first == "skills" || first == "artifact" || first == "task" || first == "history" || first == "ui" {
			for _, sub := range strings.Split(m[2], "|") {
				if sub == "" || strings.HasPrefix(sub, "using") {
					continue
				}
				if first == "ui" { // the help lists them as "ui <publish|list|events|remove>"
					assert.Regexp(t, `ui <[a-z|]*\b`+sub+`\b`, usage, "coral-agent ui "+sub)
					continue
				}
				assert.Contains(t, usage, first+" "+sub, "coral-agent "+first+" "+sub+" is named by the skill but not in coral-agent's help")
			}
			continue
		}
		assert.Regexp(t, "(?m)^\\s*"+first+"\\b", usage, "coral-agent "+first+" is named by the skill but is not a coral-agent command")
	}
}
