package background

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/agentmodels"
	"github.com/subgentic/coral/internal/agentsignin"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/executil"
	setreg "github.com/subgentic/coral/internal/settings"
)

// The model call of an automatic run holds no authority (Security's MUST 3 on #13928). The distilling CLI is run with
//   - no tools, no skills or commands and no MCP servers (Claude), or the read-only sandbox with the user's config and rules ignored (Codex), and no approval or web tool;
//   - none of Coral's hooks or the person's settings (Claude's settings sources are the empty temp folder's only; Codex's user config is ignored);
//   - an environment with every CORAL_ variable and every token that is not the CLI's own sign-in removed, so it cannot act as an agent or call the board;
//   - an empty temp folder as its working folder, the prompt and the redacted transcript on stdin and nothing in argv;
//   - the sign-in checked before the run and before each call (#5469), and no browser or login ever started by it.
// The model is the Workers default for the agent type (default_model_<type>); none set means the CLI's own default.

// codexOffFeatures are the Codex features (`codex features list`) an automatic run switches off: every one that lets the model act or reach outside the prompt.
var codexOffFeatures = []string{"shell_tool", "unified_exec", "hooks", "apps", "plugins", "browser_use", "browser_use_external", "computer_use", "image_generation", "view_image"}

// AutoCLI is one agent CLI the automatic run distills with.
type AutoCLI struct {
	AgentType string // claude or codex
	Path      string
	Model     string
	Timeout   time.Duration
	// signIn is the sign-in check before the run and each call; nil is agentsignin.Require. A test sets its own.
	signIn func(ctx context.Context) error
	// extraEnv is added to the stripped environment; a test uses it to point a fake CLI at its notes.
	extraEnv []string
}

// AutoKnowledgeAgentTypes are the agent CLIs an automatic run can distill with.
func AutoKnowledgeAgentTypes() []string { return []string{at.Claude, at.Codex} }

// NewAutoCLI finds the CLI of agentType and checks it can run and is signed in. The errors are ErrAutoCLIMissing, ErrAutoNotSignedIn or a plain one.
func NewAutoCLI(ctx context.Context, settings map[string]string, agentType string) (*AutoCLI, error) {
	if agentType != at.Claude && agentType != at.Codex {
		return nil, fmt.Errorf("%w: %s", ErrAutoCLIMissing, "this agent type cannot distill knowledge yet")
	}
	path, err := agent.FindCLI(settings, agentType)
	if err != nil {
		return nil, ErrAutoCLIMissing
	}
	c := &AutoCLI{AgentType: agentType, Path: path, Model: workersModel(settings, agentType), Timeout: knowledgeCallTimeoutFromSettings(settings)}
	if err := agentsignin.RequireFresh(ctx, agentType, path); err != nil {
		return nil, mapSignInError(err)
	}
	return c, nil
}

// workersModel is the Workers default for the type (default_model_<type>), kept only if it can be a command-line value; "" is the CLI's own default.
func workersModel(settings map[string]string, agentType string) string {
	m := setreg.TextFamily(settings, setreg.DefaultModelPrefix+agentType)
	if m != "" && !agentmodels.ValidModelValue(m) {
		return ""
	}
	return m
}

func mapSignInError(err error) error {
	if agentsignin.IsNotSignedIn(err) {
		return ErrAutoNotSignedIn
	}
	return err
}

// The environment of a call is an ALLOWLIST (Security's SHOULD 3 on #13928): the names the CLI needs to start and to sign in, and nothing else, so a variable nobody thought of (AWS_SECRET_ACCESS_KEY, a
// database URL, a Coral variable) never reaches a process that reads a transcript. Names are compared in upper case (Windows folds them).
var autoEnvNames = map[string]bool{
	"PATH": true, "HOME": true, "USER": true, "LOGNAME": true, "LANG": true, "LANGUAGE": true, "TZ": true, "TERM": true,
	"TMPDIR": true, "TEMP": true, "TMP": true,
	"USERPROFILE": true, "APPDATA": true, "LOCALAPPDATA": true, "PROGRAMDATA": true, "PROGRAMFILES": true, "PROGRAMFILES(X86)": true,
	"SYSTEMROOT": true, "SYSTEMDRIVE": true, "WINDIR": true, "COMSPEC": true, "PATHEXT": true, "HOMEDRIVE": true, "HOMEPATH": true,
	"XDG_CONFIG_HOME": true, "XDG_DATA_HOME": true, "XDG_CACHE_HOME": true, "XDG_STATE_HOME": true, "XDG_RUNTIME_DIR": true,
	"HTTP_PROXY": true, "HTTPS_PROXY": true, "NO_PROXY": true, "ALL_PROXY": true,
	"SSL_CERT_FILE": true, "SSL_CERT_DIR": true, "NODE_EXTRA_CA_CERTS": true, "REQUESTS_CA_BUNDLE": true, "CURL_CA_BUNDLE": true,
}

// autoEnvPrefixes are the CLIs' own variables (their sign-in, their config folder), by prefix. CORAL_ is not among them.
var autoEnvPrefixes = []string{"LC_", "ANTHROPIC_", "CLAUDE_", "OPENAI_", "CODEX_"}

// authorityFreeEnv is env reduced to the allowlist.
func authorityFreeEnv(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		name, _, _ := strings.Cut(kv, "=")
		up := strings.ToUpper(name)
		ok := autoEnvNames[up]
		for _, p := range autoEnvPrefixes {
			if strings.HasPrefix(up, p) {
				ok = true
			}
		}
		if ok {
			out = append(out, kv)
		}
	}
	return out
}

// args are the command line of one call: no prompt and no transcript in it. dir is the empty working folder; last is where Codex writes its final message.
func (c *AutoCLI) args(dir, last string) []string {
	model, _ := agentmodels.ModelArgs(c.Model) // "" and an invalid value both give none
	if c.AgentType == at.Codex {
		a := []string{"exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--ignore-user-config", "--ignore-rules", "-C", dir, "--output-last-message", last}
		// Codex's own tools are switched off for this call (Security's SHOULD 2): its shell and exec tools (the read-only sandbox still lets a model read any file the user can), hooks, apps, plugins, the
		// browser and computer use, and image generation. What is left is the model's answer.
		for _, feature := range codexOffFeatures {
			a = append(a, "--disable", feature)
		}
		a = append(a, model...)
		return append(a, "-") // the prompt is read from stdin
	}
	a := []string{"--print", "--no-session-persistence", "--tools", "", "--disable-slash-commands", "--strict-mcp-config", "--setting-sources", "project"}
	return append(a, model...)
}

// Call is one model call: system prompt and an optional transcript go on stdin.
func (c *AutoCLI) Call(ctx context.Context, systemPrompt, content string) (string, error) {
	input := systemPrompt
	if content != "" {
		if len(content) > maxKnowledgeTranscriptChars {
			half := maxKnowledgeTranscriptChars / 2
			content = content[:half] + "\n\n[... middle of transcript truncated ...]\n\n" + content[len(content)-half:]
		}
		input = systemPrompt + "\n\n---\n\nSession transcript:\n\n" + content
	}
	check := c.signIn
	if check == nil {
		check = func(ctx context.Context) error { return agentsignin.Require(ctx, c.AgentType, c.Path) }
	}
	if err := check(ctx); err != nil {
		return "", mapSignInError(err)
	}
	dir, err := os.MkdirTemp("", "coral-knowledge-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	last := filepath.Join(dir, ".last-message")
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = 2 * time.Minute
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := executil.Command(callCtx, c.Path, c.args(dir, last)...)
	cmd.Dir = dir
	cmd.Env = append(agent.CLIEnv(authorityFreeEnv(os.Environ()), c.Path), c.extraEnv...) // an npm-installed CLI runs with its own node (#5899)
	cmd.Stdin = strings.NewReader(input)
	setSysProcAttr(cmd)
	executil.NoCwdSearch(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		if callCtx.Err() == context.DeadlineExceeded {
			return "", ErrAutoTimedOut
		}
		return "", errors.New("the agent CLI failed") // its own words are not kept: they could carry anything
	}
	if c.AgentType == at.Codex {
		if b, rerr := os.ReadFile(last); rerr == nil {
			return strings.TrimSpace(string(b)), nil
		}
	}
	return strings.TrimSpace(string(out)), nil
}
