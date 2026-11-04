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
