package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
)

// #17622 (the Operator: "the orchestrator on the other team doesn't know that it can launch agents"): the Orchestrator's prompt says what its team's settings let it do.

func TestTheCanDoSectionForEachSetting(t *testing.T) {
	off := teamAbilities{BoardID: "b-123", Dir: "/work/team", AgentType: "claude", Model: "haiku"}
	on := off
	on.MayLaunch = true

	// All off: launching adds a line only because its off text tells the Orchestrator what to do instead.
	lines := orchestratorCanDo(off)
	require.Len(t, lines, 1)
	assert.Contains(t, lines[0], "ask the Operator to add that agent")
	assert.NotContains(t, lines[0], "coral-agent launch")
	assert.Equal(t, "What you can do on this team:\n- "+lines[0], canDoSection(lines))

	// Launch on: the exact command with this team's real folder, board, type and model, and the role and the job left for the Orchestrator.
	lines = orchestratorCanDo(on)
	require.Len(t, lines, 1)
	assert.Contains(t, lines[0], `run coral-agent launch /work/team --name "<Role>" --type claude --model haiku --prompt "<its job>" --board b-123.`)
	assert.Contains(t, lines[0], "Keep the type and model shown")
	assert.NotContains(t, lines[0], "ask the Operator")

	// A model the seat does not name is not made up; a folder with a space or a quote is one word.
	bare := on
	bare.Model, bare.Dir = "", "/work/my team's"
	assert.Contains(t, launchAbility(bare), `coral-agent launch '/work/my team'\''s' --name "<Role>" --type claude --prompt "<its job>" --board b-123.`)
	assert.NotContains(t, launchAbility(bare), "--model")

	assert.Equal(t, "", canDoSection(nil), "no line, no section")
}

func TestTheRosterSentenceFollowsTheLaunchSetting(t *testing.T) {
	members := []launchTeamAgent{{Name: "Orchestrator"}, {Name: "Lead Developer", Prompt: "Build the features."}}
	asked := teamRosterNote(members, "Orchestrator", false)
	assert.Contains(t, asked, "ask the Operator to add that agent")
	assert.NotContains(t, asked, "add that member yourself")
	own := teamRosterNote(members, "Orchestrator", true)
	assert.Contains(t, own, "add that member yourself, as described below, and say so.")
	assert.NotContains(t, own, "ask the Operator")
}

func TestModelInFlags(t *testing.T) {
	assert.Equal(t, "haiku", modelInFlags([]string{"--permission-mode", "plan", "--model", "haiku"}))
	assert.Equal(t, "sonnet", modelInFlags([]string{"--model=sonnet"}))
	assert.Equal(t, "o3", modelInFlags([]string{"-m", "o3"}))
	assert.Equal(t, "", modelInFlags([]string{"--model"}), "a flag with no value names nothing")
	assert.Equal(t, "", modelInFlags(nil))
}

// The prompt's section is built from the grant as it is now: off, on, and on while the Operator's team is still starting (the grant row is written once the seat has started).
func TestTheAbilitiesSectionFollowsTheTeamsGrant(t *testing.T) {
	r := newOrchRig(t)
	r.usualBoard()
	section := BoardAbilitiesSection(r.h.bs)
	p := agent.LaunchParams{BoardName: orchBoard, WorkingDir: r.work, Role: "Orchestrator", Flags: []string{"--model", "haiku"}}
	want := func(mayLaunch bool) string {
		return canDoSection(orchestratorCanDo(teamAbilities{MayLaunch: mayLaunch, BoardID: orchBoard, Dir: r.work, AgentType: "claude", Model: "haiku"}))
	}
	assert.Equal(t, want(false), section(p, "claude"), "no grant row: ask the Operator")
	grantStarting.Store(orchBoard, true)
	assert.Equal(t, want(true), section(p, "claude"), "a team being started: on")
	grantStarting.Delete(orchBoard)
	assert.Equal(t, want(false), section(p, "claude"))
	code, _ := r.operatorGrant("Orchestrator", nil)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, want(true), section(p, "claude"), "the grant is on")
	code, _ = r.operatorGrant("Orchestrator", map[string]any{"enabled": false})
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, want(false), section(p, "claude"), "turned off again: the next restart or wake says so")
}

// Flip the setting on a running team: the Orchestrator seat gets exactly one notice with the line its prompt would have, and nobody else does; flip it back and it gets the off notice; saving the same value again says nothing.
func TestFlippingTheLaunchSettingTellsTheRunningOrchestratorOnce(t *testing.T) {
	r := newOrchRig(t)
	ctx := context.Background()
	r.usualBoard()
	seat, err := r.ss.GetLiveSession(ctx, r.sid["Orchestrator"])
	require.NoError(t, err)
	onLine := launchAbility(abilitiesOf(seat, orchBoard, true))
	offLine := launchAbility(abilitiesOf(seat, orchBoard, false))
	notices := func() []string {
		msgs, err := r.h.bs.ListMessages(ctx, orchBoard, 100, 0, 0)
		require.NoError(t, err)
		var out []string
		for _, m := range msgs {
			if strings.Contains(m.Content, "The Operator changed a setting of your team") {
				out = append(out, m.Content)
			}
		}
		return out
	}
	assert.Empty(t, notices())

	code, _ := r.operatorGrant("Orchestrator", nil)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, []string{"@Orchestrator " + settingsChangedNotice(onLine)}, notices(), "turned on: the launch line, to the seat alone")
	assert.Contains(t, notices()[0], `coral-agent launch `+shellWord(r.work)+` --name "<Role>" --type claude --prompt "<its job>" --board team.`)

	code, _ = r.operatorGrant("Orchestrator", map[string]any{"max_per_hour": 7})
	require.Equal(t, http.StatusOK, code)
	code, _ = r.operatorGrant("Orchestrator", nil)
	require.Equal(t, http.StatusOK, code)
	assert.Len(t, notices(), 1, "the switch did not change, so nothing more is said")

	code, _ = r.operatorGrant("Orchestrator", map[string]any{"enabled": false})
	require.Equal(t, http.StatusOK, code)
	got := notices()
	require.Len(t, got, 2)
	assert.Equal(t, "@Orchestrator "+settingsChangedNotice(offLine), got[1], "turned off: ask the Operator")
	assert.Contains(t, got[1], "ask the Operator")
}

// The documented command works: its folder, type, model and board, sent as coral-agent launch sends them, start an agent on the right board with the team's model.
func TestTheDocumentedLaunchCommandJoinsTheBoardWithTheTeamsModel(t *testing.T) {
	r := newOrchRig(t)
	ctx := context.Background()
	r.usualBoard()
	code, _ := r.operatorGrant("Orchestrator", nil)
	require.Equal(t, http.StatusOK, code)
	line := orchestratorCanDo(teamAbilities{MayLaunch: true, BoardID: orchBoard, Dir: r.work, AgentType: "claude", Model: "haiku"})[0]
	m := regexp.MustCompile(`run coral-agent launch (\S+) --name "<Role>" --type (\S+) --model (\S+) --prompt "<its job>" --board (\S+)\.`).FindStringSubmatch(line)
	require.NotNil(t, m, line)
	dir, agentType, model, boardID := m[1], m[2], m[3], m[4]
	body, _ := json.Marshal(map[string]any{"working_dir": dir, "agent_type": agentType, "display_name": "Reviewer", "model": model, "prompt": "Review the changes.", "board_id": boardID})
	before := len(r.term.sentCommands())
	status, out := r.do("POST", "/api/sessions/launch", string(body), nil, r.tok["Orchestrator"])
	require.Equal(t, http.StatusOK, status, "%v", out)
	sent := r.term.sentCommands()[before:]
	require.NotEmpty(t, sent)
	assert.Contains(t, strings.Join(sent, "\n"), "--model haiku", "the team's model")
	subs, err := r.h.bs.ListSubscribers(ctx, orchBoard)
	require.NoError(t, err)
	var names []string
	for _, s := range subs {
		names = append(names, s.SubscriberID)
	}
	assert.Contains(t, names, "Reviewer", "the new agent is on the team's board")
}
