package routes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/robfig/cron/v3"

	"github.com/subgentic/coral/internal/background"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/gitutil"
	"github.com/subgentic/coral/internal/httputil"
	"github.com/subgentic/coral/internal/safefs"
	"github.com/subgentic/coral/internal/store"
)

// A team's Orchestrator drafts workflows and automations (#21505). Everything it proposes is stored OFF and goes to the Operator's Needs you with the whole text of every step, its schedule and a hash; only the
// Operator's own click on Approve enables exactly that hash. An Orchestrator can propose, change, disable, delete and test-run an approved one; it can never enable one, set the team an automation posts to
// (workflow.board), or reach the Operator's /api/workflows and /api/scheduled routes. None of these routes is reachable through Coral Hub.

// Limits of a proposal: they keep the whole of it showable on one card and bound what can land in Needs you.
const (
	maxAutomationSteps      = 10
	maxAutomationCommand    = 4000
	maxAutomationPrompt     = 8000
	maxAutomationText       = 24000 // the commands, prompts and description of one proposal together
	maxAutomationDesc       = 500
	maxAutomationName       = 60
	maxAutomationStepTimeS  = 3600
	maxAutomationDurationS  = 3600
	defaultAutomationDurS   = 1800
	minAutomationEvery      = 15 * time.Minute // the floor on how often a schedule may fire
	maxAutomationWords      = 15000            // the card's words, cut nowhere: a proposal whose words are longer is refused
	automationTestRunsHour  = 6
	maxAutomationBodyBytes  = 128 << 10
	maxAutomationRunsListed = 20
)

type automationDeps struct {
	ws     *store.WorkflowStore
	teams  *store.TeamStore
	runner *background.WorkflowRunner
}

// SetAutomations gives the automation routes the workflow store, the teams (each team's repo folder) and the runner (the test run, and the question it files again when an approved automation changed).
func (h *BoardHandler) SetAutomations(ws *store.WorkflowStore, teams *store.TeamStore, runner *background.WorkflowRunner) {
	h.auto = automationDeps{ws: ws, teams: teams, runner: runner}
	h.SetAutomationRunner(runner)
}

// SetAutomationRunner sets the runner after it exists (it is made after the routes).
func (h *BoardHandler) SetAutomationRunner(runner *background.WorkflowRunner) {
	h.auto.runner = runner
	if runner != nil {
		runner.SetApprovalNeeded(func(ctx context.Context, wf *store.Workflow) { h.askAutomationApproval(ctx, wf.Team, wf) })
	}
}

// automationOrchestrator is the caller of a route that writes: the verified agent whose own team this is and who is its Orchestrator. The Operator uses Automations, the workers and every other role are refused, and a
// request through Coral Hub is refused before anything is read.
func (h *BoardHandler) automationOrchestrator(w http.ResponseWriter, r *http.Request) (project, who string, ok bool) {
	project = urlParam(r, "project")
	if cloud.Tunneled(r) {
		errForbidden(w, "a team's automations are managed on this computer, not through Coral Hub")
		return "", "", false
	}
	if h.auto.ws == nil || h.auto.teams == nil {
		errForbidden(w, "automations are not set up on this Coral")
		return "", "", false
	}
	deny := func() (string, string, bool) {
		errForbidden(w, "only the Orchestrator of this team can propose or change its automations")
		return "", "", false
	}
	owner, verified := VerifiedSession(r.Context())
	if !verified {
		return deny()
	}
	sub, err := h.bs.GetSubscriptionBySessionName(r.Context(), owner.SessionName)
	if err != nil || sub == nil || sub.Project != project {
		return deny()
	}
	orch, err := h.bs.TeamOrchestrator(r.Context(), project)
	if err != nil || !board.SameIdentity(orch, sub.SubscriberID) {
		return deny()
	}
	return project, sub.SubscriberID, true
}

// automationReader is the caller of a route that reads: the team's Orchestrator, or the Operator at this computer.
func (h *BoardHandler) automationReader(w http.ResponseWriter, r *http.Request) (project string, ok bool) {
	project = urlParam(r, "project")
	if cloud.Tunneled(r) {
		errForbidden(w, "a team's automations are managed on this computer, not through Coral Hub")
		return "", false
	}
	if h.auto.ws == nil {
		errForbidden(w, "automations are not set up on this Coral")
		return "", false
	}
	if _, ok := h.healthAdmin(r, project); !ok {
		errForbidden(w, "only the team's orchestrator or the Operator can read its automations")
		return "", false
	}
	return project, true
}

// automationBody is what a proposal says. enabled, board and team are named only to be refused: an Orchestrator cannot set them.
type automationBody struct {
	Name         string            `json:"name"`
	Description  string            `json:"description"`
	RepoPath     string            `json:"repo_path"`
	BaseBranch   string            `json:"base_branch"`
	Steps        []json.RawMessage `json:"steps"`
	DefaultAgent json.RawMessage   `json:"default_agent"`
	MaxDurationS *int              `json:"max_duration_s"`
	Schedule     *struct {
		Cron     string `json:"cron"`
		Timezone string `json:"timezone"`
	} `json:"schedule"`
	Enabled json.RawMessage `json:"enabled"`
	Board   json.RawMessage `json:"board"`
	Team    json.RawMessage `json:"team"`
}

// shownWhole says whether text can be put on a card as it is: no control or format character (a right-to-left override, a zero-width character) that would make the card read differently from what runs.
func shownWhole(s string) bool {
	for _, r := range s {
		if r == '\n' || r == '\t' {
			continue
		}
		if unicode.Is(unicode.Cc, r) || unicode.Is(unicode.Cf, r) || unicode.Is(unicode.Zl, r) || unicode.Is(unicode.Zp, r) || r == unicode.ReplacementChar {
			return false
		}
	}
	return true
}

// teamFolder is the team's own repo folder after symlinks: the only folder its automations run in.
func (h *BoardHandler) teamFolder(ctx context.Context, project string) (string, string) {
	t, err := h.auto.teams.GetTeam(ctx, project)
	if err != nil || t == nil || strings.TrimSpace(t.WorkingDir) == "" {
		return "", "this team has no repo folder to run an automation in"
	}
	dir, err := canonicalizeRepoPath(t.WorkingDir)
	if err != nil {
		return "", "the team's repo folder is not there"
	}
	return dir, ""
}

// buildTeamAutomation checks a proposal and builds the workflow and job it stands for. why is the refusal in words.
func (h *BoardHandler) buildTeamAutomation(ctx context.Context, project, who, name string, b automationBody) (wf *store.Workflow, job *store.ScheduledJob, appr background.Approval, why string) {
	if len(b.Enabled) > 0 || len(b.Board) > 0 || len(b.Team) > 0 {
		return nil, nil, appr, "an Orchestrator cannot set enabled, board or team: a proposal starts off, and the Operator turns it on by approving it"
	}
	if name == "" || len(name) > maxAutomationName || !workflowNameRe.MatchString(name) || safefs.CheckName(name) != nil {
		return nil, nil, appr, "name: letters, digits, - and _ only, up to 60"
	}
	if len(b.Steps) == 0 || len(b.Steps) > maxAutomationSteps {
		return nil, nil, appr, fmt.Sprintf("steps: between 1 and %d steps", maxAutomationSteps)
	}
	if len(b.Description) > maxAutomationDesc {
		return nil, nil, appr, "description: at most 500 characters"
	}
	total := len(b.Description) + len(name)
	for i, raw := range b.Steps {
		var st struct {
			Name     string `json:"name"`
			Command  string `json:"command"`
			Prompt   string `json:"prompt"`
			TimeoutS *int   `json:"timeout_s"`
		}
		_ = json.Unmarshal(raw, &st)
		if len(st.Command) > maxAutomationCommand || len(st.Prompt) > maxAutomationPrompt {
			return nil, nil, appr, fmt.Sprintf("step %d: a command is at most %d bytes and a prompt %d, so the Operator can read all of it", i+1, maxAutomationCommand, maxAutomationPrompt)
		}
		if st.TimeoutS != nil && (*st.TimeoutS <= 0 || *st.TimeoutS > maxAutomationStepTimeS) {
			return nil, nil, appr, fmt.Sprintf("step %d: timeout_s is at most %d", i+1, maxAutomationStepTimeS)
		}
		total += len(st.Name) + len(st.Command) + len(st.Prompt)
		if !shownWhole(st.Name) || !shownWhole(st.Command) || !shownWhole(st.Prompt) {
			return nil, nil, appr, fmt.Sprintf("step %d: control or invisible characters cannot be shown on the card", i+1)
		}
	}
	if total > maxAutomationText || !shownWhole(b.Description) {
		return nil, nil, appr, "the proposal is too long to be shown whole on one card, or has characters that cannot be shown"
	}
	if msg := validateSteps(b.Steps, b.DefaultAgent); msg != "" {
		return nil, nil, appr, msg
	}
	folder, why := h.teamFolder(ctx, project)
	if why != "" {
		return nil, nil, appr, why
	}
	if b.RepoPath != "" {
		given, err := canonicalizeRepoPath(b.RepoPath)
		if err != nil || filepath.Clean(given) != filepath.Clean(folder) {
			return nil, nil, appr, "repo_path: an automation runs in the team's own repo folder only (" + folder + "); leave repo_path out"
		}
	}
	if b.BaseBranch != "" {
		if err := gitutil.ValidRef(b.BaseBranch); err != nil {
			return nil, nil, appr, "base_branch: " + err.Error()
		}
	}
	dur := defaultAutomationDurS
	if b.MaxDurationS != nil {
		if *b.MaxDurationS <= 0 || *b.MaxDurationS > maxAutomationDurationS {
			return nil, nil, appr, fmt.Sprintf("max_duration_s: at most %d", maxAutomationDurationS)
		}
		dur = *b.MaxDurationS
	}
	stepsJSON, err := store.StepsJSONFromRaw(b.Steps)
	if err != nil {
		return nil, nil, appr, "steps: invalid"
	}
	wf = &store.Workflow{Name: name, Description: b.Description, StepsJSON: stepsJSON, DefaultAgentJSON: string(b.DefaultAgent), RepoPath: folder, BaseBranch: b.BaseBranch,
		MaxDurationS: dur, CleanupWorktree: 1, Team: project, ProposedBy: who}
	if string(b.DefaultAgent) == "null" {
		wf.DefaultAgentJSON = ""
	}
	if msg := background.TeamStepsProblem(wf); msg != "" {
		return nil, nil, appr, msg
	}
	if b.Schedule != nil && b.Schedule.Cron != "" {
		tz := b.Schedule.Timezone
		if tz == "" {
			tz = "UTC"
		}
		if msg := checkAutomationSchedule(b.Schedule.Cron, tz); msg != "" {
			return nil, nil, appr, msg
		}
		job = &store.ScheduledJob{Name: name, Description: "Team automation of " + project, CronExpr: b.Schedule.Cron, Timezone: tz, MaxDurationS: dur}
	}
	appr, err = background.ApprovalOf(wf, job)
	if err != nil {
		return nil, nil, appr, err.Error()
	}
	if len(automationWords(project, wf, job, appr, nil)) > maxAutomationWords {
		return nil, nil, appr, "the proposal is too long to be shown whole on one card"
	}
	return wf, job, appr, ""
}

// checkAutomationSchedule refuses a cron expression that does not parse, a time zone that does not exist, and one that fires more often than the floor.
func checkAutomationSchedule(expr, tz string) string {
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return "schedule.timezone: not a time zone name"
	}
	sch, err := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow).Parse(expr)
	if err != nil {
		return "schedule.cron: not a five-field cron expression (minute hour day month weekday)"
	}
	t := time.Now().In(loc)
	prev := sch.Next(t)
	if prev.IsZero() {
		return "schedule.cron: it never fires"
	}
	for i := 0; i < 200; i++ {
		next := sch.Next(prev)
		if next.IsZero() {
			break
		}
		if next.Sub(prev) < minAutomationEvery {
			return fmt.Sprintf("schedule.cron: it may fire at most every %d minutes", int(minAutomationEvery/time.Minute))
		}
		prev = next
	}
	return ""
}

// automationState is where a proposal stands.
func automationState(wf *store.Workflow, now background.Approval) string {
	switch {
	case wf.ApprovedHash == "":
		return "pending"
	case now.Hash != wf.ApprovedHash:
		return "changed"
	case wf.Enabled == 1:
		return "approved"
	default:
		return "off"
	}
}

type automationStepView struct {
	Index             int    `json:"index"`
	Name              string `json:"name"`
	Type              string `json:"type"`
	Command           string `json:"command,omitempty"`
	Prompt            string `json:"prompt,omitempty"`
	AgentType         string `json:"agent_type,omitempty"`
	Model             string `json:"model,omitempty"`
	TimeoutS          int    `json:"timeout_s,omitempty"`
	ContinueOnFailure bool   `json:"continue_on_failure"`
	// File is the repo file this step runs: its bytes are part of the approval. EditableFiles is true for a shell step that runs other files of the repo the team can change after the approval (make, npm test).
	File          string `json:"file,omitempty"`
	EditableFiles bool   `json:"editable_files"`
}

type automationView struct {
	Name         string               `json:"name"`
	Description  string               `json:"description"`
	Team         string               `json:"team"`
	ProposedBy   string               `json:"proposed_by"`
	State        string               `json:"state"` // pending, approved, changed, off
	Enabled      bool                 `json:"enabled"`
	Hash         string               `json:"hash"`
	ApprovedHash string               `json:"approved_hash,omitempty"`
	RepoPath     string               `json:"repo_path"`
	Cron         string               `json:"cron,omitempty"`
	Timezone     string               `json:"timezone,omitempty"`
	MaxDurationS int                  `json:"max_duration_s"`
	Steps        []automationStepView `json:"steps"`
	Changes      []string             `json:"changes,omitempty"`
	Words        string               `json:"words"`
	Problem      string               `json:"problem,omitempty"` // why the hash cannot be made now (a file the steps run is gone)
	UpdatedAt    string               `json:"updated_at"`
}

func (h *BoardHandler) automationView(ctx context.Context, wf *store.Workflow) automationView {
	job, _ := h.auto.ws.TeamWorkflowJobOf(ctx, wf.ID)
	appr, err := background.ApprovalOf(wf, job)
	v := automationView{Name: wf.Name, Description: wf.Description, Team: wf.Team, ProposedBy: wf.ProposedBy, Enabled: wf.Enabled == 1, Hash: appr.Hash, ApprovedHash: wf.ApprovedHash,
		RepoPath: wf.RepoPath, MaxDurationS: wf.MaxDurationS, UpdatedAt: wf.UpdatedAt, Steps: []automationStepView{}}
	if err != nil {
		v.Problem = err.Error()
	}
	if job != nil {
		v.Cron, v.Timezone = job.CronExpr, job.Timezone
	}
	var steps []background.StepDef
	_ = json.Unmarshal([]byte(wf.StepsJSON), &steps)
	editable := map[int]bool{}
	for _, i := range appr.EditableSteps {
		editable[i] = true
	}
	files := map[int]string{}
	for _, f := range appr.Files {
		files[f.Step] = f.Path
	}
	for i, st := range steps {
		sv := automationStepView{Index: i + 1, Name: st.Name, Type: st.Type, Command: st.Command, Prompt: st.Prompt, TimeoutS: st.TimeoutS, ContinueOnFailure: st.ContinueOnFailure, File: files[i], EditableFiles: editable[i]}
		if st.Type == "agent" {
			var def background.AgentStepConfig
			if wf.DefaultAgentJSON != "" {
				_ = json.Unmarshal([]byte(wf.DefaultAgentJSON), &def)
			}
			sv.AgentType, sv.Model = def.AgentType, def.Model
			if st.Agent != nil {
				if st.Agent.AgentType != "" {
					sv.AgentType = st.Agent.AgentType
				}
				if st.Agent.Model != "" {
					sv.Model = st.Agent.Model
				}
			}
		}
		v.Steps = append(v.Steps, sv)
	}
	v.State = automationState(wf, appr)
	if v.State == "changed" {
		v.Changes = background.ApprovalChanges(wf.ApprovedSnapshot, wf, job)
	}
	v.Words = automationWords(wf.Team, wf, job, appr, v.Changes)
	return v
}

// automationWords is the card in words: every step whole, the schedule, the folder and the hash. It is what the question says, and what an agent or the command line shows; the dashboard's card shows the same
// content in its own layout.
func automationWords(project string, wf *store.Workflow, job *store.ScheduledJob, appr background.Approval, changes []string) string {
	var b strings.Builder
	if wf.ApprovedHash != "" {
		fmt.Fprintf(&b, "Changed since you approved: %s (team %s). It was approved as %s; this version is %s. It is off until you approve it again, and nothing ran from this version.\n", wf.Name, project, short(wf.ApprovedHash), short(appr.Hash))
		if len(changes) > 0 {
			b.WriteString("What changed:\n")
			for _, c := range changes {
				b.WriteString("  " + c + "\n")
			}
		}
	} else {
		fmt.Fprintf(&b, "An automation waits for your approval: %s (team %s). It starts off.\n", wf.Name, project)
	}
	if wf.Description != "" {
		fmt.Fprintf(&b, "Description: %s\n", wf.Description)
	}
	fmt.Fprintf(&b, "Proposed by: the Orchestrator of %s (%s). Repo folder: %s.\n", project, wf.ProposedBy, wf.RepoPath)
	if job != nil {
		fmt.Fprintf(&b, "Runs: on the schedule %q (%s), for at most %d seconds.\n", job.CronExpr, job.Timezone, wf.MaxDurationS)
	} else {
		fmt.Fprintf(&b, "Runs: only when someone runs it (no schedule), for at most %d seconds.\n", wf.MaxDurationS)
	}
	fmt.Fprintf(&b, "Hash: %s (covers every step below, the schedule, the folder and the repo files named below).\n", appr.Hash)
	var steps []background.StepDef
	_ = json.Unmarshal([]byte(wf.StepsJSON), &steps)
	files := map[int]string{}
	for _, f := range appr.Files {
		files[f.Step] = f.Path
	}
	editable := map[int]bool{}
	for _, i := range appr.EditableSteps {
		editable[i] = true
	}
	fmt.Fprintf(&b, "%d steps, in order:\n", len(steps))
	for i, st := range steps {
		fail := "stops the run if it fails"
		if st.ContinueOnFailure {
			fail = "keeps going if it fails"
		}
		if st.Type == "agent" {
			fmt.Fprintf(&b, "Step %d: %s (agent, %s). Agent step: it runs with an agent's own permissions, as an agent the Orchestrator launches would, and signs in as usual.\n", i+1, st.Name, fail)
			fmt.Fprintf(&b, "Prompt:\n%s\n", st.Prompt)
			continue
		}
		fmt.Fprintf(&b, "Step %d: %s (shell, %s), in %s:\n%s\n", i+1, st.Name, fail, wf.RepoPath, st.Command)
		if f := files[i]; f != "" {
			fmt.Fprintf(&b, "  %s is part of this approval; if it changes, the run stops and you are asked again. It covers this file only, not what the file runs.\n", f)
		} else if editable[i] {
			b.WriteString("  This step runs files your team can change after you approve.\n")
		}
	}
	b.WriteString("A shell step runs as you, on this computer: it can read every file you can read. It gets none of Coral's tokens or keys in its environment. (An agent step signs in as usual.)\n")
	b.WriteString("Nothing runs until you approve. Approving enables exactly this version; any later edit turns it off and asks you again. Deny removes the proposal. Only you can approve it, on this computer: a Hub link cannot.")
	return b.String()
}

func short(h string) string {
	if len(h) > 8 {
		return h[:8]
	}
	return h
}

// askAutomationApproval files the Operator's question for a proposal: the words, and an Approve and a Deny that carry this hash. An earlier question for the same automation is closed (it is out of date).
func (h *BoardHandler) askAutomationApproval(ctx context.Context, project string, wf *store.Workflow) {
	if h.bs == nil || h.auto.ws == nil {
		return
	}
	job, _ := h.auto.ws.TeamWorkflowJobOf(ctx, wf.ID)
	appr, err := background.ApprovalOf(wf, job)
	if err != nil {
		slog.Warn("automation approval question not filed", "board", project, "automation", wf.Name, "error", err)
		return
	}
	h.closeAutomationAsks(ctx, project, wf.Name, "the automation changed: a new question replaces this one")
	var names []string
	if subs, err := h.bs.ListSubscribers(ctx, project); err == nil {
		for _, s := range subs {
			names = append(names, s.SubscriberID)
		}
	}
	changes := []string(nil)
	if wf.ApprovedHash != "" {
		changes = background.ApprovalChanges(wf.ApprovedSnapshot, wf, job)
	}
	content := "@Operator [Coral] " + board.DefuseMentions(automationWords(project, wf, job, appr, changes), names)
	msg, err := h.bs.PostSystemDefusedMessage(ctx, project, "Coral", content, nil)
	if err != nil {
		slog.Warn("automation approval question not posted", "board", project, "automation", wf.Name, "error", err)
		return
	}
	if err := h.bs.RecordAsk(ctx, project, msg, []string{board.OperatorName}); err != nil {
		slog.Warn("automation approval question not recorded", "board", project, "automation", wf.Name, "error", err)
		return
	}
	arg := board.CheckButtonArg(wf.Name, appr.Hash)
	yes := "Approve"
	if wf.ApprovedHash != "" {
		yes = "Approve again"
	}
	buttons := []board.AskButton{{Label: yes, Action: board.ActionApproveAutomation, Arg: arg}, {Label: "Deny", Action: board.ActionDenyAutomation, Arg: arg}}
	if err := h.bs.RecordAskButtons(ctx, project, msg.ID, buttons, time.Now()); err != nil {
		slog.Warn("automation approval buttons not stored", "board", project, "automation", wf.Name, "error", err)
	}
	if h.notifyFn != nil {
		h.notifyFn(project)
	}
}

func (h *BoardHandler) closeAutomationAsks(ctx context.Context, project, name, note string) {
	ids, err := h.bs.OpenAutomationApprovalAsks(ctx, project, name)
	if err != nil {
		return
	}
	for _, id := range ids {
		_ = h.bs.CloseAsk(ctx, project, id, "Coral", note)
	}
}

func automationErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrTeamWorkflowLimit), errors.Is(err, store.ErrTeamProposalRate):
		httputil.WriteActionLimit(w, 0, "automation_limit", err.Error()) // a limit on one action: marked, so the dashboard does not pause its pollers
	case errors.Is(err, store.ErrTeamWorkflowMissing):
		errNotFound(w, "no such automation on this team")
	case err != nil && strings.Contains(err.Error(), "UNIQUE"):
		errConflict(w, "an automation or a scheduled job with that name already exists")
	default:
		errInternalServer(w, "the automation could not be saved")
	}
}

// ListAutomationsRoute answers GET /api/board/{project}/automations.
func (h *BoardHandler) ListAutomationsRoute(w http.ResponseWriter, r *http.Request) {
	project, ok := h.automationReader(w, r)
	if !ok {
		return
	}
	list, err := h.auto.ws.ListTeamWorkflows(r.Context(), project)
	if err != nil {
		errInternalServer(w, "could not read the automations")
		return
	}
	out := make([]automationView, 0, len(list))
	for i := range list {
		out = append(out, h.automationView(r.Context(), &list[i]))
	}
	writeJSON(w, http.StatusOK, map[string]any{"automations": out})
}

// GetAutomationRoute answers GET /api/board/{project}/automations/{name}: the automation whole, and its latest runs.
func (h *BoardHandler) GetAutomationRoute(w http.ResponseWriter, r *http.Request) {
	project, ok := h.automationReader(w, r)
	if !ok {
		return
	}
	wf, err := h.auto.ws.TeamWorkflowByName(r.Context(), project, urlParam(r, "name"))
	if err != nil {
		errInternalServer(w, "could not read the automation")
		return
	}
	if wf == nil {
		errNotFound(w, "no such automation on this team")
		return
	}
	type runView struct {
		ID         int64   `json:"id"`
		Status     string  `json:"status"`
		Trigger    string  `json:"trigger"`
		StartedAt  *string `json:"started_at"`
		FinishedAt *string `json:"finished_at"`
	}
	runs := []runView{}
	if rs, err := h.auto.ws.ListRunsForWorkflow(r.Context(), wf.ID, maxAutomationRunsListed, 0, nil); err == nil {
		for _, x := range rs {
			runs = append(runs, runView{ID: x.ID, Status: x.Status, Trigger: x.TriggerType, StartedAt: x.StartedAt, FinishedAt: x.FinishedAt})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"automation": h.automationView(r.Context(), wf), "runs": runs})
}

// ProposeAutomationRoute answers POST /api/board/{project}/automations: a new automation, stored off, with the Operator's question filed.
func (h *BoardHandler) ProposeAutomationRoute(w http.ResponseWriter, r *http.Request) {
	project, who, ok := h.automationOrchestrator(w, r)
	if !ok {
		return
	}
	var b automationBody
	if err := decodeJSONMax(w, r, &b, maxAutomationBodyBytes); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	if existing, _ := h.auto.ws.GetWorkflowByName(r.Context(), b.Name); existing != nil {
		errConflict(w, "a workflow with that name already exists")
		return
	}
	wf, job, appr, why := h.buildTeamAutomation(r.Context(), project, who, b.Name, b)
	if why != "" {
		errBadRequest(w, why)
		return
	}
	created, _, err := h.auto.ws.CreateTeamWorkflow(r.Context(), wf, job, appr.Hash, time.Now())
	if err != nil {
		automationErr(w, err)
		return
	}
	h.askAutomationApproval(r.Context(), project, created)
	writeJSON(w, http.StatusCreated, h.automationView(r.Context(), created))
}

// ChangeAutomationRoute answers PUT /api/board/{project}/automations/{name}: the whole new definition. The automation and its job go OFF in the same write, whatever the change, and the Operator is asked again.
func (h *BoardHandler) ChangeAutomationRoute(w http.ResponseWriter, r *http.Request) {
	project, who, ok := h.automationOrchestrator(w, r)
	if !ok {
		return
	}
	name := urlParam(r, "name")
	var b automationBody
	if err := decodeJSONMax(w, r, &b, maxAutomationBodyBytes); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	if b.Name != "" && b.Name != name {
		errBadRequest(w, "an automation's name cannot change")
		return
	}
	cur, err := h.auto.ws.TeamWorkflowByName(r.Context(), project, name)
	if err != nil {
		errInternalServer(w, "could not read the automation")
		return
	}
	if cur == nil {
		errNotFound(w, "no such automation on this team")
		return
	}
	wf, job, appr, why := h.buildTeamAutomation(r.Context(), project, who, name, b)
	if why != "" {
		errBadRequest(w, why)
		return
	}
	wf.ID = cur.ID
	if _, _, err := h.auto.ws.ReplaceTeamWorkflow(r.Context(), wf, job, appr.Hash, who, time.Now()); err != nil {
		automationErr(w, err)
		return
	}
	h.killAutomationRuns(r.Context(), cur.ID) // a run that began under the old version ends with it
	_ = h.auto.ws.DB().RevokeAutomationTokensForWorkflow(r.Context(), cur.ID, time.Now())
	fresh, _ := h.auto.ws.GetWorkflow(r.Context(), cur.ID)
	h.askAutomationApproval(r.Context(), project, fresh)
	writeJSON(w, http.StatusOK, h.automationView(r.Context(), fresh))
}

func (h *BoardHandler) killAutomationRuns(ctx context.Context, id int64) {
	if h.auto.runner == nil {
		return
	}
	if active, err := h.auto.ws.GetActiveRunsForWorkflow(ctx, id); err == nil {
		for _, run := range active {
			h.auto.runner.KillRun(ctx, run.ID)
		}
	}
}

// DisableAutomationRoute answers POST /api/board/{project}/automations/{name}/disable: the automation and its job off. There is no route that turns one on: only the Operator's Approve does.
func (h *BoardHandler) DisableAutomationRoute(w http.ResponseWriter, r *http.Request) {
	project, who, ok := h.automationOrchestrator(w, r)
	if !ok {
		return
	}
	wf, err := h.auto.ws.TeamWorkflowByName(r.Context(), project, urlParam(r, "name"))
	if err != nil || wf == nil {
		errNotFound(w, "no such automation on this team")
		return
	}
	if err := h.auto.ws.DisableTeamWorkflow(r.Context(), wf.ID, store.TeamWorkflowEventDisable, wf.ApprovedHash, who); err != nil {
		automationErr(w, err)
		return
	}
	h.killAutomationRuns(r.Context(), wf.ID)
	_ = h.auto.ws.DB().RevokeAutomationTokensForWorkflow(r.Context(), wf.ID, time.Now())
	fresh, _ := h.auto.ws.GetWorkflow(r.Context(), wf.ID)
	writeJSON(w, http.StatusOK, h.automationView(r.Context(), fresh))
}

// DeleteAutomationRoute answers DELETE /api/board/{project}/automations/{name}.
func (h *BoardHandler) DeleteAutomationRoute(w http.ResponseWriter, r *http.Request) {
	project, who, ok := h.automationOrchestrator(w, r)
	if !ok {
		return
	}
	wf, err := h.auto.ws.TeamWorkflowByName(r.Context(), project, urlParam(r, "name"))
	if err != nil || wf == nil {
		errNotFound(w, "no such automation on this team")
		return
	}
	if err := h.deleteTeamAutomation(r.Context(), wf, store.TeamWorkflowEventDelete, who); err != nil {
		automationErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// deleteTeamAutomation removes the automation, its job, its runs' folders and state folder, and closes its open questions.
func (h *BoardHandler) deleteTeamAutomation(ctx context.Context, wf *store.Workflow, kind, who string) error {
	runIDs, _ := h.auto.ws.WorkflowRunIDs(ctx, wf.ID)
	h.killAutomationRuns(ctx, wf.ID)
	if err := h.auto.ws.DeleteTeamWorkflow(ctx, wf.ID, kind, wf.ApprovedHash, who); err != nil {
		return err
	}
	if dir := h.coralDir; dir != "" {
		background.RemoveRunDirs(dir, runIDs)
		background.RemoveWorkflowState(dir, wf.ID)
	}
	_ = h.auto.ws.DB().RevokeAutomationTokensForWorkflow(ctx, wf.ID, time.Now())
	h.closeAutomationAsks(ctx, wf.Team, wf.Name, "the automation was removed")
	return nil
}

var automationRunMu sync.Mutex

// RunAutomationRoute answers POST /api/board/{project}/automations/{name}/run: one test run of an automation whose CURRENT hash the Operator approved. A proposal, an automation that changed and one that is off
// cannot be run by an agent (the runner's gate refuses them too, whoever asks). At most one run at a time and a few an hour.
func (h *BoardHandler) RunAutomationRoute(w http.ResponseWriter, r *http.Request) {
	project, who, ok := h.automationOrchestrator(w, r)
	if !ok {
		return
	}
	if h.auto.runner == nil {
		errConflict(w, "workflows cannot run now")
		return
	}
	wf, err := h.auto.ws.TeamWorkflowByName(r.Context(), project, urlParam(r, "name"))
	if err != nil || wf == nil {
		errNotFound(w, "no such automation on this team")
		return
	}
	if wf.Enabled != 1 || wf.ApprovedHash == "" {
		errConflict(w, "only an automation the Operator has approved, in its current version, can be run: this one is not approved, or it is off")
		return
	}
	automationRunMu.Lock() // the active-run check and the start are one step: two calls at once start one run
	defer automationRunMu.Unlock()
	if active, _ := h.auto.ws.GetActiveRunsForWorkflow(r.Context(), wf.ID); len(active) > 0 {
		errConflict(w, "a run of this automation is already going")
		return
	}
	slot, err := h.auto.ws.ClaimTeamTestRun(r.Context(), project, wf.ID, wf.Name, wf.ApprovedHash, who, automationTestRunsHour) // the hourly count and the record are one transaction
	if err != nil {
		if errors.Is(err, store.ErrTeamTestRunLimit) {
			httputil.WriteActionLimit(w, 0, "automation_limit", fmt.Sprintf("a team may test-run at most %d automations an hour", automationTestRunsHour))
			return
		}
		errInternalServer(w, "the run could not start")
		return
	}
	trig := "test run by the Orchestrator"
	run, err := h.auto.runner.TriggerWorkflow(r.Context(), wf, "api", &trig)
	if err != nil {
		h.auto.ws.ReleaseTeamTestRun(r.Context(), slot) // it did not start: the slot is not used
		var rae *background.ApprovalRequiredError
		if errors.As(err, &rae) {
			errConflict(w, rae.Error())
			return
		}
		var limit *background.ConcurrencyLimitError
		if errors.As(err, &limit) {
			errConflict(w, "workflow runs are already in progress: try again when one finishes")
			return
		}
		errInternalServer(w, "the run could not start")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"run_id": run.ID, "status": run.Status, "automation": wf.Name})
}

// runAutomationButton runs a claimed Approve or Deny of an automation's question. It answers the request itself. The click has passed buttonClickCaller (the person's own act, never an API key, a link key or an agent token)
// and the Hub refusal. Approve is a compare-and-set on the hash the question carries: the hash is computed again from what is stored, inside the transaction that enables, so a proposal that changed since, or a repo
// file the steps run that changed, enables nothing.
func (h *BoardHandler) runAutomationButton(w http.ResponseWriter, r *http.Request, project string, askID int64, b board.AskButton, out map[string]any) {
	ctx := r.Context()
	stale := func(code, why string) {
		_ = h.bs.CloseAsk(ctx, project, askID, "Coral", why)
		writeError(w, http.StatusConflict, code, why)
	}
	name, hash, ok := board.SplitCheckButtonArg(b.Arg)
	if !ok || h.auto.ws == nil {
		stale("automation_gone", "this question names no automation")
		return
	}
	wf, err := h.auto.ws.TeamWorkflowByName(ctx, project, name)
	if err != nil {
		_, _ = h.bs.ReleaseAskButton(ctx, project, askID, b.ID)
		errInternalServer(w, "could not read the automation")
		return
	}
	if wf == nil {
		stale("automation_gone", "the automation is no longer on this team")
		return
	}
	job, _ := h.auto.ws.TeamWorkflowJobOf(ctx, wf.ID)
	appr, aerr := background.ApprovalOf(wf, job)
	if aerr != nil || appr.Hash != hash {
		stale("automation_changed", "the automation changed since this question was filed: look at the new question")
		return
	}
	if b.Action == board.ActionApproveAutomation {
		cur := func(w *store.Workflow, j *store.ScheduledJob) (string, string, error) {
			a, err := background.ApprovalOf(w, j)
			return a.Hash, background.ApprovalSnapshot(w, j), err
		}
		if err := h.auto.ws.ApproveTeamWorkflow(ctx, wf.ID, hash, appr.FilesJSON(), "Operator", cur); err != nil {
			if errors.Is(err, store.ErrTeamWorkflowChanged) {
				stale("automation_changed", "the automation changed since this question was filed: look at the new question")
				return
			}
			_, _ = h.bs.ReleaseAskButton(ctx, project, askID, b.ID) // the question stays, to be clicked again
			errInternalServer(w, "could not approve the automation")
			return
		}
		out["result"] = "approved"
	} else {
		var derr error
		if wf.ApprovedHash == "" { // a proposal that was never approved: Deny removes it
			derr = h.deleteTeamAutomation(ctx, wf, store.TeamWorkflowEventDeny, "Operator")
		} else { // one that was approved before and changed: Deny keeps it off
			derr = h.auto.ws.DisableTeamWorkflow(ctx, wf.ID, store.TeamWorkflowEventDeny, hash, "Operator")
		}
		if derr != nil {
			_, _ = h.bs.ReleaseAskButton(ctx, project, askID, b.ID)
			errInternalServer(w, "could not deny the automation")
			return
		}
		out["result"] = "denied"
	}
	out["ran"] = true
	_ = h.bs.CloseAsk(ctx, project, askID, "Operator", out["result"].(string)+" automation "+name)
	writeJSON(w, http.StatusOK, out)
}
