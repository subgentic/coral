package background

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/subgentic/coral/internal/safefs"
	"github.com/subgentic/coral/internal/store"
)

// The approval of a workflow a team's Orchestrator proposed (#21505). ApprovalOf hashes everything that runs or decides when it runs, and for a shell step that starts by running a file of the repo, the bytes of that
// file too. The Operator approves one hash; a run refuses to start unless what is stored hashes to it.

// ApprovalVersion is mixed into the hash: a change to what the hash covers makes every old approval stale, never silently valid.
const ApprovalVersion = 1

// MaxApprovedFileBytes is the biggest repo file a step may run and have hashed.
const MaxApprovedFileBytes = 4 << 20

// ApprovedFile is a repo file a step runs, and the SHA-256 of its bytes when it was hashed.
type ApprovedFile struct {
	Step   int    `json:"step"`
	Path   string `json:"path"`   // as the step names it, relative to the repo folder
	SHA256 string `json:"sha256"` // of the file's bytes
}

// Approval is what ApprovalOf finds: the hash, the files it covers, and the shell steps that run something else the team can edit.
type Approval struct {
	Hash  string         `json:"hash"`
	Files []ApprovedFile `json:"files"`
	// EditableSteps are the shell steps (counted from 0) whose command is not a lone call of a repo file: make, npm test, a tool, a pipeline. Whatever they run is not hashed, so the card says so.
	EditableSteps []int `json:"editable_steps"`
}

// FilesJSON is Files as stored with the approval.
func (a Approval) FilesJSON() string {
	b, _ := json.Marshal(a.Files)
	return string(b)
}

// shellControl are the characters that make a command more than one plain call: any of them anywhere keeps the file from being hashed as THE thing the step runs.
const shellControl = "\n\r;&|<>()`$\\\"'*?[]{}!~#"

// RepoFileOf says which file of the repo a shell step's command runs, when the command is exactly one plain call of a path ("./run.sh --x", "scripts/check.py a b"): the path as written, relative. ok is false for
// anything else (make, npm test, a bare tool, an absolute path, a pipeline, a quoted or expanded word).
func RepoFileOf(command string) (rel string, ok bool) {
	c := strings.TrimSpace(command)
	if c == "" || strings.ContainsAny(c, shellControl) {
		return "", false
	}
	first := strings.Fields(c)[0]
	if !strings.Contains(first, "/") || filepath.IsAbs(first) || strings.HasPrefix(first, "-") || strings.HasPrefix(first, "~") || strings.Contains(first, "%") {
		return "", false
	}
	return first, true
}

// ApprovalError is why a workflow's approval cannot be made or checked.
type ApprovalError struct{ Msg string }

func (e *ApprovalError) Error() string { return e.Msg }

func approvalErr(f string, a ...any) error { return &ApprovalError{Msg: fmt.Sprintf(f, a...)} }

// hashRepoFile is the SHA-256 of a regular file of the repo folder, refused when it is outside the folder after symlinks, not a regular file, or too big.
func hashRepoFile(repo, rel string) (string, error) {
	root, err := safefs.Resolve(repo)
	if err != nil {
		return "", approvalErr("the repo folder is not there")
	}
	p, err := safefs.Resolve(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		return "", approvalErr("%s is not a file in the repo folder", rel)
	}
	if p != root && !strings.HasPrefix(p, root+string(filepath.Separator)) {
		return "", approvalErr("%s is outside the repo folder", rel)
	}
	fi, err := os.Stat(p)
	if err != nil || !fi.Mode().IsRegular() {
		return "", approvalErr("%s is not a file in the repo folder", rel)
	}
	if fi.Size() > MaxApprovedFileBytes {
		return "", approvalErr("%s is bigger than %d MB", rel, MaxApprovedFileBytes>>20)
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return "", approvalErr("%s cannot be read", rel)
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

// canonical decodes JSON text and encodes it again: object keys sorted, so equal content hashes equal whatever its spelling. Text that is not JSON hashes as itself.
func canonical(text string) any {
	if strings.TrimSpace(text) == "" {
		return nil
	}
	var v any
	if json.Unmarshal([]byte(text), &v) != nil {
		return text
	}
	return v
}

// ApprovalOf is the approval record of a workflow and its job (nil when it has none) as they are now. It reads the repo files the steps run.
func ApprovalOf(wf *store.Workflow, job *store.ScheduledJob) (Approval, error) {
	var steps []json.RawMessage
	if wf.StepsJSON != "" {
		if err := json.Unmarshal([]byte(wf.StepsJSON), &steps); err != nil {
			return Approval{}, approvalErr("the steps cannot be read")
		}
	}
	var a Approval
	canonSteps := make([]any, 0, len(steps))
	for i, raw := range steps {
		var st struct {
			Type    string `json:"type"`
			Command string `json:"command"`
		}
		_ = json.Unmarshal(raw, &st)
		var any1 any
		_ = json.Unmarshal(raw, &any1)
		canonSteps = append(canonSteps, any1)
		if st.Type != "shell" {
			continue
		}
		if rel, ok := RepoFileOf(st.Command); ok {
			sum, err := hashRepoFile(wf.RepoPath, rel)
			if err != nil {
				return Approval{}, fmt.Errorf("step %d: %w", i+1, err)
			}
			a.Files = append(a.Files, ApprovedFile{Step: i, Path: rel, SHA256: sum})
		} else {
			a.EditableSteps = append(a.EditableSteps, i)
		}
	}
	rec := map[string]any{
		"v": ApprovalVersion, "name": wf.Name, "team": wf.Team, "description": wf.Description, "repo_path": wf.RepoPath, "base_branch": wf.BaseBranch,
		"max_duration_s": wf.MaxDurationS, "cleanup_worktree": wf.CleanupWorktree, "board": wf.Board,
		"default_agent": canonical(wf.DefaultAgentJSON), "steps": canonSteps, "files": a.Files,
	}
	if job != nil {
		rec["schedule"] = map[string]any{"cron": job.CronExpr, "timezone": job.Timezone, "max_duration_s": job.MaxDurationS}
	}
	b, err := json.Marshal(rec)
	if err != nil {
		return Approval{}, err
	}
	sum := sha256.Sum256(b)
	a.Hash = hex.EncodeToString(sum[:])
	return a, nil
}

// ApprovalRequiredError is a run refused because what would run is not what the Operator approved.
type ApprovalRequiredError struct {
	Workflow string
	Why      string
	// Changed is true when something was approved before and what runs now differs: the workflow was turned off and the Operator is asked again.
	Changed bool
}

func (e *ApprovalRequiredError) Error() string {
	return fmt.Sprintf("workflow %q was not run: %s", e.Workflow, e.Why)
}

// SetApprovalNeeded sets what is told when a run finds that what would run differs from what was approved (it files the Operator's question again).
func (wr *WorkflowRunner) SetApprovalNeeded(fn func(ctx context.Context, wf *store.Workflow)) {
	wr.approvalNeeded = fn
}

// requireApproval is the gate of every run of a workflow a team proposed (TriggerWorkflow, so the dashboard, the scheduler, a webhook and the test run all pass it): the workflow is on, something was approved, and
// what is stored now, with the bytes of the repo files its steps run, hashes to it. A difference turns the workflow and its job off in one write and asks the Operator again.
func (wr *WorkflowRunner) requireApproval(ctx context.Context, wf *store.Workflow) (*store.Workflow, error) {
	team, err := wr.store.IsTeamWorkflow(ctx, wf.ID) // from the database, with its error: the value we were handed may have been read without its team
	if err != nil {
		return nil, &ApprovalRequiredError{Workflow: wf.Name, Why: "its approval could not be read"}
	}
	if !team {
		return wf, nil
	}
	fresh, err := wr.store.GetWorkflow(ctx, wf.ID)
	if err != nil || fresh == nil || fresh.Team == "" {
		return nil, &ApprovalRequiredError{Workflow: wf.Name, Why: "it is not there any more, or its approval could not be read"}
	}
	if fresh.Enabled != 1 {
		return nil, &ApprovalRequiredError{Workflow: wf.Name, Why: "it is off: the Operator turns it on by approving it"}
	}
	if fresh.ApprovedHash == "" {
		return nil, &ApprovalRequiredError{Workflow: wf.Name, Why: "the Operator has not approved it"}
	}
	job, _ := wr.store.TeamWorkflowJobOf(ctx, fresh.ID)
	if why := TeamStepsProblem(fresh); why != "" {
		_ = wr.store.DisableTeamWorkflow(ctx, fresh.ID, store.TeamWorkflowEventRefused, fresh.ApprovedHash, "Coral")
		return nil, &ApprovalRequiredError{Workflow: wf.Name, Why: why, Changed: true}
	}
	now, err := ApprovalOf(fresh, job)
	if err != nil || now.Hash != fresh.ApprovedHash {
		why := "it changed since the Operator approved it"
		var ae *ApprovalError
		if errors.As(err, &ae) {
			why = "it no longer matches what the Operator approved: " + ae.Msg
		}
		_ = wr.store.DisableTeamWorkflow(ctx, fresh.ID, store.TeamWorkflowEventRefused, fresh.ApprovedHash, "Coral")
		if wr.approvalNeeded != nil {
			if f2, e2 := wr.store.GetWorkflow(ctx, fresh.ID); e2 == nil && f2 != nil {
				wr.approvalNeeded(ctx, f2)
			}
		}
		return nil, &ApprovalRequiredError{Workflow: wf.Name, Why: why + ": it is off until the Operator approves it again", Changed: true}
	}
	return fresh, nil
}

// recheckStepFile is run just before a shell step of a team workflow starts: the file the step runs must still be the bytes that were approved (an earlier step may have written it). An empty answer is fine.
func (wr *WorkflowRunner) recheckStepFile(ctx context.Context, wf *store.Workflow, stepIndex int, step StepDef) string {
	if wf.Team == "" || step.Type != "shell" {
		return ""
	}
	rel, ok := RepoFileOf(step.Command)
	if !ok {
		return ""
	}
	fresh, err := wr.store.GetWorkflow(ctx, wf.ID)
	if err != nil || fresh == nil {
		return "the workflow is not there any more"
	}
	var approved []ApprovedFile
	_ = json.Unmarshal([]byte(fresh.ApprovedFiles), &approved)
	for _, f := range approved {
		if f.Step != stepIndex || f.Path != rel {
			continue
		}
		sum, err := hashRepoFile(wf.RepoPath, rel)
		if err != nil || sum != f.SHA256 {
			_ = wr.store.DisableTeamWorkflow(ctx, wf.ID, store.TeamWorkflowEventRefused, fresh.ApprovedHash, "Coral")
			if wr.approvalNeeded != nil {
				if f2, e2 := wr.store.GetWorkflow(ctx, wf.ID); e2 == nil && f2 != nil {
					wr.approvalNeeded(ctx, f2)
				}
			}
			return rel + " changed after the Operator approved it"
		}
		return ""
	}
	return rel + " was not part of what the Operator approved"
}

// TeamStepsProblem says why a proposed workflow's steps are outside what an Orchestrator may set up, or "" when they are fine. An agent step runs under the cap of an agent an Orchestrator launches: its agent
// type and model only, no flags, tools, capabilities or hooks of its own, never interactive. A shell step may not carry hooks (a hook is a command that runs outside the step's own text).
func TeamStepsProblem(wf *store.Workflow) string {
	var steps []StepDef
	if err := json.Unmarshal([]byte(wf.StepsJSON), &steps); err != nil {
		return "the steps cannot be read"
	}
	if wf.Board != "" && strings.ContainsAny(wf.Name, "@") {
		return "a workflow that posts to a team has no @ in its name"
	}
	checkAgent := func(where string, a *AgentStepConfig) string {
		if a == nil {
			return ""
		}
		if len(a.Flags) > 0 || len(a.Tools) > 0 || len(a.Capabilities) > 0 && string(a.Capabilities) != "null" {
			return where + ": an agent step of a team's automation sets its agent type and model only: no flags, tools or capabilities"
		}
		return ""
	}
	if wf.DefaultAgentJSON != "" {
		var d AgentStepConfig
		if json.Unmarshal([]byte(wf.DefaultAgentJSON), &d) == nil {
			if why := checkAgent("default_agent", &d); why != "" {
				return why
			}
		}
	}
	for i, st := range steps {
		if len(st.Hooks) > 0 && string(st.Hooks) != "null" {
			return fmt.Sprintf("step %d: hooks are not allowed in a team's automation", i+1)
		}
		if len(st.Connections) > 0 {
			return fmt.Sprintf("step %d: connections are not allowed", i+1)
		}
		if st.Interactive {
			return fmt.Sprintf("step %d: an interactive step is not allowed in a team's automation", i+1)
		}
		if why := checkAgent(fmt.Sprintf("step %d", i+1), st.Agent); why != "" {
			return why
		}
	}
	return ""
}

// strictEnvMarker is put on a shell step's environment by runStep for a team's automation, and taken off by executeShellStep: the step is then given allowedBaseEnv in place of Coral's own environment.
const strictEnvMarker = "CORAL_INTERNAL_STRICT_ENV=1"

func takeStrictEnv(env []string) ([]string, bool) {
	out := make([]string, 0, len(env))
	strict := false
	for _, kv := range env {
		if kv == strictEnvMarker {
			strict = true
			continue
		}
		out = append(out, kv)
	}
	return out, strict
}

// allowedEnvNames are the variables a team's automation inherits from Coral: what a shell needs to find programs, files and its locale, and nothing that is a credential. Coral's own variables arrive through
// the step's environment (buildStepEnv), and a step is still the person's shell for every file they can read: the card says that and no more.
var allowedEnvNames = map[string]bool{
	"PATH": true, "HOME": true, "USER": true, "LOGNAME": true, "SHELL": true, "LANG": true, "LANGUAGE": true, "TZ": true, "TERM": true, "TMPDIR": true, "TMP": true, "TEMP": true,
	// Windows
	"SYSTEMROOT": true, "SYSTEMDRIVE": true, "WINDIR": true, "COMSPEC": true, "PATHEXT": true, "USERPROFILE": true, "USERNAME": true, "HOMEDRIVE": true, "HOMEPATH": true,
	"LOCALAPPDATA": true, "APPDATA": true, "PROGRAMFILES": true, "PROGRAMDATA": true, "NUMBER_OF_PROCESSORS": true, "PROCESSOR_ARCHITECTURE": true, "OS": true,
}

func allowedBaseEnv(env []string) []string {
	out := make([]string, 0, 16)
	for _, kv := range env {
		name, _, _ := strings.Cut(kv, "=")
		up := strings.ToUpper(name)
		if allowedEnvNames[up] || strings.HasPrefix(up, "LC_") {
			out = append(out, kv)
		}
	}
	return out
}
