package routes

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/subgentic/coral/internal/background"
	"github.com/subgentic/coral/internal/safefs"
)

// canonicalizeRepoPath resolves symlinks and validates that the path is an existing directory.
// errNotADirectory is canonicalizeRepoPath's error for a path that exists but
// isn't a directory.
var errNotADirectory = errors.New("not a directory")

// repoPathError is the 400 message for a repo_path canonicalizeRepoPath refused.
func repoPathError(err error) string {
	if errors.Is(err, errNotADirectory) {
		return "repo_path is not a directory"
	}
	return "repo_path does not exist"
}

func canonicalizeRepoPath(p string) (string, error) {
	cleaned := filepath.Clean(p)
	resolved, err := safefs.Resolve(cleaned)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errNotADirectory
	}
	return resolved, nil
}

// validateSteps validates step definitions per the spec rules.
func validateSteps(steps []json.RawMessage, defaultAgent json.RawMessage) string {
	stepNames := make(map[string]bool)
	if agentNamesMCP(defaultAgent) {
		return "default_agent: " + errMCPNotSupported
	}

	for i, stepRaw := range steps {
		var step struct {
			Name              string          `json:"name"`
			Type              string          `json:"type"`
			Command           string          `json:"command"`
			Prompt            string          `json:"prompt"`
			TimeoutS          *int            `json:"timeout_s"`
			ContinueOnFailure bool            `json:"continue_on_failure"`
			Agent             json.RawMessage `json:"agent"`
			Hooks             json.RawMessage `json:"hooks"`
			OutputArtifact    string          `json:"output_artifact"`
			Interactive       bool            `json:"interactive"`
		}
		if err := json.Unmarshal(stepRaw, &step); err != nil {
			return fmt.Sprintf("step %d: invalid JSON", i)
		}
		if agentNamesMCP(step.Agent) {
			return fmt.Sprintf("step %d: agent: %s", i, errMCPNotSupported)
		}
		// output_artifact stays inside the step's folder (#3423, CRIT-02).
		if step.OutputArtifact != "" && (!filepath.IsLocal(step.OutputArtifact) || strings.ContainsRune(step.OutputArtifact, 0)) {
			return fmt.Sprintf("step %d: output_artifact must be a relative path inside the step's folder (no absolute path, no ..)", i)
		}

		// Validate name
		if step.Name == "" {
			return fmt.Sprintf("step %d: name is required", i)
		}
		if stepNames[step.Name] {
			return "duplicate step name"
		}
		stepNames[step.Name] = true

		// Validate type
		switch step.Type {
		case "shell":
			if step.Command == "" {
				return "shell step missing command"
			}
		case "agent":
			if step.Prompt == "" {
				return "agent step missing prompt"
			}
			// Check agent_type is resolvable: the step's own, else the workflow's default.
			agentType := ""
			if step.Agent != nil {
				var agentCfg struct {
					AgentType string `json:"agent_type"`
				}
				json.Unmarshal(step.Agent, &agentCfg)
				agentType = agentCfg.AgentType
			}
			if agentType == "" && defaultAgent != nil {
				var daCfg struct {
					AgentType string `json:"agent_type"`
				}
				json.Unmarshal(defaultAgent, &daCfg)
				agentType = daCfg.AgentType
			}
			if agentType == "" {
				return "agent step missing agent_type"
			}
			// An unknown CLI is refused, and so is a print step on a CLI not verified for
			// it yet (#3522): a clear error now, not a silent failure or a guessed sandbox.
			if !background.KnownStepAgentType(agentType) {
				return fmt.Sprintf("step %d: unknown agent_type %q", i, agentType)
			}
			if !step.Interactive {
				if msg := background.PrintStepError(agentType); msg != "" {
					return fmt.Sprintf("step %d: %s", i, msg)
				}
			}
		default:
			return fmt.Sprintf("step %d: type must be 'shell' or 'agent'", i)
		}

		// Validate timeout_s
		if step.TimeoutS != nil && (*step.TimeoutS <= 0 || *step.TimeoutS > 86400) {
			return "invalid timeout"
		}

		// Validate template references
		text := step.Command + step.Prompt
		if errMsg := validateTemplateRefs(text, i, len(steps)); errMsg != "" {
			return errMsg
		}

		// Validate hooks if present
		if step.Hooks != nil {
			if errMsg := validateHooks(step.Hooks); errMsg != "" {
				return fmt.Sprintf("step %d: %s", i, errMsg)
			}
		}
	}
	return ""
}

// contentTemplate matches a template that inserts a previous step's output.
var contentTemplate = regexp.MustCompile(`\{\{\w+_content\}\}`)

// stepWarnings lists shell commands where a content template sits inside quotes (#3423):
// the runner inserts step output as one quoted shell word, so quoting it again puts the
// quotes into the value. Saving still works; the warnings come back with the workflow.
func stepWarnings(steps []json.RawMessage) []string {
	var out []string
	for i, raw := range steps {
		var step struct {
			Name    string `json:"name"`
			Type    string `json:"type"`
			Command string `json:"command"`
		}
		if json.Unmarshal(raw, &step) != nil || step.Type != "shell" {
			continue
		}
		for _, loc := range contentTemplate.FindAllStringIndex(step.Command, -1) {
			if background.ShellQuoteAt(step.Command, loc[0]) != 0 {
				out = append(out, fmt.Sprintf("step %d (%s): %s is inside quotes; it is already inserted as one quoted shell word, so remove the quotes around it (or use \"$CORAL_PREV_STDOUT\")",
					i, step.Name, step.Command[loc[0]:loc[1]]))
			}
		}
	}
	return out
}

// withWarnings adds "warnings" to a JSON object answer when there are any.
func withWarnings(v any, warnings []string) any {
	if len(warnings) == 0 {
		return v
	}
	b, err := json.Marshal(v)
	if err != nil {
		return v
	}
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return v
	}
	m["warnings"] = warnings
	return m
}

// validHookEvents are the recognized hook event names.
var validHookEvents = map[string]bool{
	"PreToolUse":   true,
	"PostToolUse":  true,
	"Stop":         true,
	"Notification": true,
	"SubagentStop": true,
	"StepComplete": true,
	"StepFailed":   true,
}

// validateHooks validates a hooks JSON object: known event names, structure, and limits.
func validateHooks(raw json.RawMessage) string {
	var hooks map[string]json.RawMessage
	if err := json.Unmarshal(raw, &hooks); err != nil {
		return "hooks must be a JSON object"
	}

	totalGroups := 0
	for event, groupsRaw := range hooks {
		if !validHookEvents[event] {
			return fmt.Sprintf("unknown hook event %q", event)
		}

		var groups []json.RawMessage
		if err := json.Unmarshal(groupsRaw, &groups); err != nil {
			return fmt.Sprintf("hooks.%s must be an array of hook groups", event)
		}

		if len(groups) > 10 {
			return fmt.Sprintf("hooks.%s exceeds max 10 groups", event)
		}
		totalGroups += len(groups)

		for j, groupRaw := range groups {
			var group struct {
				Matcher string `json:"matcher"`
				Hooks   []struct {
					Type    string `json:"type"`
					Command string `json:"command"`
				} `json:"hooks"`
			}
			if err := json.Unmarshal(groupRaw, &group); err != nil {
				return fmt.Sprintf("hooks.%s[%d]: invalid hook group", event, j)
			}
			if len(group.Hooks) == 0 {
				return fmt.Sprintf("hooks.%s[%d]: hooks array is required", event, j)
			}
			for k, h := range group.Hooks {
				if h.Type != "command" {
					return fmt.Sprintf("hooks.%s[%d].hooks[%d]: type must be \"command\"", event, j, k)
				}
				if h.Command == "" {
					return fmt.Sprintf("hooks.%s[%d].hooks[%d]: command is required", event, j, k)
				}
			}
		}
	}

	if totalGroups > 50 {
		return "hooks exceed max 50 total groups"
	}

	return ""
}

// stepRefRe matches {{step_N_...}} template patterns and captures N.
var stepRefRe = regexp.MustCompile(`\{\{step_(\d+)_`)

// validateTemplateRefs checks template variable references in step text.
func validateTemplateRefs(text string, stepIndex, totalSteps int) string {
	// Check {{prev_*}} references on step 0
	if stepIndex == 0 {
		for _, tmpl := range []string{"{{prev_dir}}", "{{prev_stdout}}", "{{prev_stderr}}"} {
			if strings.Contains(text, tmpl) {
				return "step 0 cannot reference previous step"
			}
		}
	}

	// Check {{step_N_*}} references — N must be < current step index and within bounds
	matches := stepRefRe.FindAllStringSubmatch(text, -1)
	for _, match := range matches {
		n, err := strconv.Atoi(match[1])
		if err != nil {
			return "template references invalid step index"
		}
		if n >= stepIndex || n >= totalSteps {
			return "template references invalid step index"
		}
	}

	return ""
}
