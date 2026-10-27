package board

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// #8919: the built-in Coding Team template (the dashboard's team_templates_ui.js) is the six-role team plus its Orchestrator, and it starts a new team in the Task queue working mode. The template is
// dashboard data, so this reads its source, and checks its mode against the built-in presets here so the two cannot drift apart.

func frontendSource(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "pkg", "frontend", "static", name))
	require.NoError(t, err)
	return string(b)
}

func TestCodingTeamTemplateHasTheSixRolesAndStartsInTaskQueue(t *testing.T) {
	src := frontendSource(t, "team_templates_ui.js")
	start := strings.Index(src, `name: "Coding Team"`)
	end := strings.Index(src, `name: "Consumer Research"`)
	require.True(t, start >= 0 && end > start, "the Coding Team is the first built-in template")
	block := src[start:end]

	names := []string{}
	for _, m := range regexp.MustCompile(`\{ name: "([^"]+)", prompt: `).FindAllStringSubmatch(block, -1) {
		names = append(names, m[1])
	}
	require.Equal(t, []string{"Orchestrator", "Lead Developer", "QA Engineer", "DevOps Engineer", "Frontend Dev", "Backend Dev", "Security Reviewer"}, names,
		"the Orchestrator and the six roles: DevOps, Frontend, Backend, Lead, QA and Security")

	m := regexp.MustCompile(`\bmode: "([a-z_]+)"`).FindStringSubmatch(block)
	require.NotNil(t, m, "the template names its working mode")
	require.Equal(t, "task_queue", m[1])
	preset, ok := builtinWorkflowPreset(m[1])
	require.True(t, ok, "and it is a built-in preset of the board")
	require.Equal(t, "Task queue", preset.Name)

	// the other built-in templates keep no working mode of their own
	require.NotRegexp(t, `\bmode: "`, src[end:], "only the Coding Team names a working mode")
}

func TestChoosingATemplateSetsTheLaunchFormsWorkingMode(t *testing.T) {
	dialogs := frontendSource(t, "team_dialogs.js")
	require.Contains(t, dialogs, "setTeamLaunchMode(tmpl.mode || 'none')", "loading a template applies the mode it names, or None: a Coding Team picked first does not leave Task queue on another template")
	require.Contains(t, dialogs, "applyTeamBoardSettings, setTeamLaunchMode }", "and the dialog imports the setter")

	settings := frontendSource(t, "team_launch_settings.js")
	require.Contains(t, settings, "export function setTeamLaunchMode(mode)")
	require.Contains(t, settings, "mode: _defaultMode,", "a step that is still loading starts with the template's mode")
	require.Contains(t, settings, "if (_view) _view.destroy();\n    _defaultMode = 'none';", "and mounting the step for a new dialog starts every team at None again")
	require.Contains(t, settings, "{ value: 'task_queue', label: 'Task queue' }", "the Working mode select offers it")
}
