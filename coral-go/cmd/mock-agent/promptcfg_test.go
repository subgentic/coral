package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// With no file the menus are the ones the mock has always drawn, byte for byte (suites read them).
func TestDefaultPromptMenusAreUnchanged(t *testing.T) {
	t.Setenv("MOCK_PROMPTS_FILE", "")
	c := loadPromptCfg()
	if got := questionMenuFor(c, false); got != questionMenu {
		t.Errorf("question menu changed:\n%q\nwant\n%q", got, questionMenu)
	}
	if got := questionMenuFor(c, true); got != questionTextMenu {
		t.Errorf("question menu with text changed:\n%q\nwant\n%q", got, questionTextMenu)
	}
	if c.Permission.Command != "rm -rf build" || c.Permission.Description != "Remove the build folder" || c.Question.Header != "Color" {
		t.Errorf("default words changed: %+v", c)
	}
}

// MOCK_PROMPTS_FILE sets the words; a field it leaves out stays; a file that is not usable changes nothing.
func TestPromptsFileSetsTheWords(t *testing.T) {
	write := func(body string) {
		p := filepath.Join(t.TempDir(), "prompts.json")
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("MOCK_PROMPTS_FILE", p)
	}
	write(`{"question":{"header":"Units","question":"Show Celsius or Fahrenheit?","options":[{"label":"Celsius","description":"Metric"},{"label":"Fahrenheit","description":"US"}]},"permission":{"command":"npm run build"}}`)
	c := loadPromptCfg()
	menu := questionMenuFor(c, false)
	if !strings.Contains(menu, "Show Celsius or Fahrenheit?") || !strings.Contains(menu, "❯ 1. Celsius") || !strings.Contains(menu, "  2. Fahrenheit") {
		t.Errorf("menu does not carry the words: %q", menu)
	}
	if c.Permission.Command != "npm run build" || c.Permission.Description != "Remove the build folder" {
		t.Errorf("permission words: %+v (the description a file leaves out stays)", c.Permission)
	}
	if opts := c.questionOptions(); len(opts) != 2 {
		t.Errorf("payload options: %v", opts)
	}
	for _, bad := range []string{`{"question": `, `[]`, `{"question":{"options":[{"label":"Only one"}]}}`} {
		write(bad)
		if got := loadPromptCfg(); got.Question.Question != "Pick a color:" || len(got.Question.Options) != 2 || got.Question.Options[0].Label != "Red" {
			t.Errorf("an unusable file %q changed the words: %+v", bad, got.Question)
		}
	}
}

// QA Reviewer 2's SHOULDs on #13180: the hook payloads carry the file's labels (and the defaults the old ones), and a malformed file changes neither the menu nor the payload.
func TestPromptPayloadsCarryTheLabels(t *testing.T) {
	t.Setenv("MOCK_PROMPTS_FILE", "")
	def := loadPromptCfg()
	q := def.questionRequestInput()["questions"].([]any)[0].(map[string]any)
	opts := q["options"].([]any)
	if q["header"] != "Color" || q["question"] != "Pick a color:" || len(opts) != 2 || opts[0].(map[string]any)["label"] != "Red" || opts[1].(map[string]any)["label"] != "Blue" {
		t.Errorf("default question payload changed: %v", q)
	}
	if p := def.permissionRequestInput(); p["command"] != "rm -rf build" || p["description"] != "Remove the build folder" {
		t.Errorf("default permission payload changed: %v", p)
	}
	path := filepath.Join(t.TempDir(), "prompts.json")
	os.WriteFile(path, []byte(`{"question":{"header":"Units","question":"Celsius or Fahrenheit?","options":[{"label":"Celsius","description":"Metric"},{"label":"Fahrenheit","description":"US"}]},"permission":{"command":"npm run build","description":"Build"}}`), 0o600)
	t.Setenv("MOCK_PROMPTS_FILE", path)
	c := loadPromptCfg()
	q = c.questionRequestInput()["questions"].([]any)[0].(map[string]any)
	opts = q["options"].([]any)
	if q["header"] != "Units" || q["question"] != "Celsius or Fahrenheit?" || opts[0].(map[string]any)["label"] != "Celsius" || opts[1].(map[string]any)["label"] != "Fahrenheit" {
		t.Errorf("question payload lacks the file's labels: %v", q)
	}
	if p := c.permissionRequestInput(); p["command"] != "npm run build" || p["description"] != "Build" {
		t.Errorf("permission payload lacks the file's words: %v", p)
	}
	// a malformed file: nothing changes, menu and payload alike
	os.WriteFile(path, []byte(`{"question": {"options": [`), 0o600)
	m := loadPromptCfg()
	if questionMenuFor(m, false) != questionMenu || m.permissionRequestInput()["command"] != "rm -rf build" {
		t.Errorf("a malformed file changed the prompts: %+v", m)
	}
}

// MOCK_AGENT_GOAL is the one-shot's answer when there is no latest request; a latest request is still echoed.
func TestOneShotGoalText(t *testing.T) {
	t.Setenv("MOCK_AGENT_GOAL", "Skyline shows a five-day forecast")
	var out strings.Builder
	printOneShot(strings.NewReader("CURRENT GOAL: (none)"), &out)
	if !strings.Contains(out.String(), "Skyline shows a five-day forecast") {
		t.Errorf("goal text not used: %s", out.String())
	}
	out.Reset()
	printOneShot(strings.NewReader("LATEST USER REQUEST:\nFix the sidebar\n"), &out)
	if !strings.Contains(out.String(), "Fix the sidebar") {
		t.Errorf("the latest request must still win: %s", out.String())
	}
	t.Setenv("MOCK_AGENT_GOAL", "")
	out.Reset()
	printOneShot(strings.NewReader("x"), &out)
	if !strings.Contains(out.String(), "Mock agent goal") {
		t.Errorf("default changed: %s", out.String())
	}
}
