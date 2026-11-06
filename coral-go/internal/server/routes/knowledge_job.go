package routes

import (
	"context"
	"encoding/json"
	"strings"

	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/background"
	"github.com/subgentic/coral/internal/store"
)

// The body of a "knowledge" job (#13928): the daily distilling of a team's knowledge, run by the scheduler in the server. No agent is started.

// SetKnowledgeScheduler gives the scheduler the body of a knowledge job.
func (h *SessionsHandler) SetKnowledgeScheduler(s *background.JobScheduler) {
	s.SetKnowledgeRunFn(h.runKnowledgeJob)
}

// TeamHasKnowledgeToDistill says a team of this computer exists (a saved team with members, or a board with live agents): the check a knowledge job's creation makes.
func (h *SessionsHandler) TeamHasKnowledgeToDistill(ctx context.Context, name string) bool {
	return background.ValidKnowledgeTeam(name) && h.teamStore != nil && h.teamExists(ctx, name)
}

func (h *SessionsHandler) runKnowledgeJob(ctx context.Context, job store.ScheduledJob, _ int64) background.AutoResult {
	team := job.TeamName
	if team == "" || !h.TeamHasKnowledgeToDistill(ctx, team) {
		return background.AutoResult{State: "failed", Reason: "the team was not found", Code: background.AutoCodeNoTeam}
	}
	settings, err := h.ss.GetSettingsForCLI(ctx)
	if err != nil {
		return background.AutoResult{State: "failed", Reason: "Coral's settings could not be read", Code: background.AutoCodeFailed}
	}
	agentType := h.knowledgeAgentType(ctx, team)
	var cli *background.AutoCLI
	a := &background.AutoKnowledge{
		SS: h.ss, TS: h.teamStore, CoralDir: h.cfg.CoralDir(),
		// The CLI is found and its sign-in checked on the first call, not before: a run with nothing new makes no call and asks nothing of the CLI.
		Call: func(ctx context.Context, system, content string) (string, error) {
			if cli == nil {
				c, err := background.NewAutoCLI(ctx, settings, agentType)
				if err != nil {
					return "", err
				}
				cli = c
			}
			return cli.Call(ctx, system, content)
		},
		ApplyAutomatically: func(t string) bool { return h.knowledgeAutoApply(ctx, t) },
	}
	return a.Run(ctx, team)
}

// knowledgeAgentType is the agent CLI a team's distilling uses: the type the team was launched with, else its first agent's, and Claude when that type cannot distill yet.
func (h *SessionsHandler) knowledgeAgentType(ctx context.Context, team string) string {
	supported := func(t string) bool {
		for _, s := range background.AutoKnowledgeAgentTypes() {
			if s == t {
				return true
			}
		}
		return false
	}
	if t, _ := h.teamStore.GetTeam(ctx, team); t != nil && t.ConfigJSON != "" {
		var cfg struct {
			AgentType string `json:"agent_type"`
		}
		if json.Unmarshal([]byte(t.ConfigJSON), &cfg) == nil && supported(strings.TrimSpace(cfg.AgentType)) {
			return strings.TrimSpace(cfg.AgentType)
		}
	}
	if rows, err := h.ss.GetBoardSessions(ctx, team); err == nil {
		for _, s := range rows {
			if supported(s.AgentType) {
				return s.AgentType
			}
		}
	}
	return at.Claude
}

// knowledgeAutoApply is the team's switch for applying a daily update by itself (background.AutoApplyDefault until the Operator sets it).
func (h *SessionsHandler) knowledgeAutoApply(_ context.Context, team string) bool {
	return background.AutoApplyOn(h.cfg.CoralDir(), team)
}
