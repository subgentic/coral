package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// MOCK_PROMPTS_FILE=<file> (#13180, for the demo film) sets the words of the prompts the mock raises on demand (MOCK_ASK_QUESTION, MOCK_ASK_PERMISSION), so a Needs you
// row can carry the story's own text and still be answerable (the menu is really on the screen). JSON, every field optional:
//
//	{"question": {"header": "Units", "question": "Celsius or Fahrenheit?", "options": [{"label": "Celsius", "description": "Metric"}, {"label": "Fahrenheit", "description": "US-style"}]},
//	 "permission": {"command": "npm run build", "description": "Build the dashboard"}}
//
// Unset, unreadable or not that JSON: the words are the ones the mock has always used (a test pins the default menus byte for byte).
type promptOption struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}

type promptCfg struct {
	Question struct {
		Header   string         `json:"header"`
		Question string         `json:"question"`
		Options  []promptOption `json:"options"`
	} `json:"question"`
	Permission struct {
		Command     string `json:"command"`
		Description string `json:"description"`
	} `json:"permission"`
}

func defaultPromptCfg() promptCfg {
	var c promptCfg
	c.Question.Header, c.Question.Question = "Color", "Pick a color:"
	c.Question.Options = []promptOption{{"Red", "Choose red"}, {"Blue", "Choose blue"}}
	c.Permission.Command, c.Permission.Description = "rm -rf build", "Remove the build folder"
	return c
}

// loadPromptCfg is the defaults with any field the file sets on top.
func loadPromptCfg() promptCfg {
	c := defaultPromptCfg()
	p := os.Getenv("MOCK_PROMPTS_FILE")
	if p == "" {
		return c
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return c
	}
	var f promptCfg
	if json.Unmarshal(b, &f) != nil {
		return c
	}
	if f.Question.Header != "" {
		c.Question.Header = f.Question.Header
	}
	if strings.TrimSpace(f.Question.Question) != "" {
		c.Question.Question = f.Question.Question
	}
	if len(f.Question.Options) >= 2 {
		c.Question.Options = f.Question.Options
	}
	if strings.TrimSpace(f.Permission.Command) != "" {
		c.Permission.Command = f.Permission.Command
	}
	if f.Permission.Description != "" {
		c.Permission.Description = f.Permission.Description
	}
	return c
}

// questionMenuFor draws the question like Claude Code's AskUserQuestion, as Coral's PromptOnScreen reads a menu; withText adds "Type something." and "Chat about this".
func questionMenuFor(c promptCfg, withText bool) string {
	var b strings.Builder
	b.WriteString("\r\n " + c.Question.Question + "\r\n")
	for i, o := range c.Question.Options {
		mark := "  "
		if i == 0 {
			mark = "❯ "
		}
		fmt.Fprintf(&b, " %s%d. %s\r\n", mark, i+1, o.Label)
	}
	if withText {
		n := len(c.Question.Options)
		fmt.Fprintf(&b, "   %d. Type something.\r\n   %d. Chat about this\r\n", n+1, n+2)
	}
	b.WriteString("\r\n Enter to select · Esc to cancel\r\n")
	return b.String()
}

// questionOptions is the hook payload's options.
func (c promptCfg) questionOptions() []any {
	var out []any
	for _, o := range c.Question.Options {
		out = append(out, map[string]any{"label": o.Label, "description": o.Description})
	}
	return out
}
