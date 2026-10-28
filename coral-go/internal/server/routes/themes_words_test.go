package routes

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// The theme editor's group names and labels are the person's words (#10558, the Mobile tester: "Rail team/folder chip text", and "rail" is a design word): the collapsed sidebar is named that, and no label says rail.
func TestThemeEditorWordsDoNotSayRail(t *testing.T) {
	for group, vars := range themeVariableGroups {
		assert.NotContains(t, strings.ToLower(group), "rail", "group %q", group)
		for name, label := range vars {
			assert.NotContains(t, strings.ToLower(label), "rail", "%s: %q", name, label)
		}
	}
	assert.Equal(t, "Team and folder label text", themeVariableGroups["Collapsed sidebar"]["--rail-chip-text"], "the label the Mobile tester read as Rail team/folder chip text")
}
