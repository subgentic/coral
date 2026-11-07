package routes

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/store"
)

// #14336, Security's ruling on #14333 (MUST 1): an agent's launch is capped by the launching agent, never raised to the new default. These are its cases, on the pure rule.

var fullCaps = &agent.Capabilities{Allow: []string{"file_read", "file_write", "shell", "git_write", "agent_spawn", "web_access"}}

func authOf(rank int, caps *agent.Capabilities) callerAuthority {
	return callerAuthority{Rank: rank, Caps: caps}
}

func TestTheRankOfEachTypesModesIsWhatItCanDoWithoutAsking(t *testing.T) {
	for _, tc := range []struct {
		typ, mode string
		want      int
	}{
		{"claude", "default", rankAsks}, {"claude", "plan", rankAsks}, {"claude", "acceptEdits", rankEdits}, {"claude", "auto", rankJudged}, {"claude", "dontAsk", rankJudged}, {"claude", "bypassPermissions", rankOpen},
		{"codex", "plan", rankAsks}, {"codex", "default", rankEdits}, {"codex", "acceptEdits", rankEdits}, {"codex", "auto", rankJudged}, {"codex", "bypassPermissions", rankOpen},
		{"agy", "default", rankAsks}, {"agy", "acceptEdits", rankEdits}, {"agy", "auto", rankAsks}, {"agy", "bypassPermissions", rankOpen},
		{"gemini", "acceptEdits", rankEdits}, {"antigravity", "bypassPermissions", rankOpen},
		{"hermes", "default", rankAsks}, {"hermes", "auto", rankAsks}, {"hermes", "bypassPermissions", rankOpen},
		{"pi", "default", rankOpen}, {"opencode", "default", rankOpen},
	} {
		assert.Equal(t, tc.want, modeRank(tc.typ, tc.mode), "%s %s", tc.typ, tc.mode)
	}
	// worked out after the translation, across types: agy's full capabilities are its yolo; Codex's are full-auto and never no-sandbox (#6422); Keep Full access is the top
	assert.Equal(t, rankOpen, effectiveRank("agy", "", fullCaps, false), "agy with full capabilities")
	assert.Equal(t, rankEdits, effectiveRank("agy", "", &agent.Capabilities{Allow: []string{"file_read", "file_write", "shell:coral-board *"}}, false), "agy with a narrowed shell")
	assert.Equal(t, rankEdits, effectiveRank("agy", "bypassPermissions", &agent.Capabilities{Allow: []string{"file_read", "file_write", "shell:coral-board *"}}, false), "an explicit bypass narrowed by capabilities is the narrower one (#14085)")
	assert.Equal(t, rankJudged, effectiveRank("codex", "", fullCaps, false), "Codex with full capabilities stays in its sandbox")
	assert.Less(t, effectiveRank("codex", "", fullCaps, false), rankOpen)
	assert.Equal(t, rankOpen, effectiveRank("claude", "default", nil, true), "Keep Full access")
}

func TestAnOrchestratorTheUserLoweredToDefaultLaunchesDefaultMembers(t *testing.T) {
	grant, refusal := capAgentLaunchFor(authOf(rankAsks, nil), agentLaunchAsk{AgentType: "claude", DefaultMode: "auto"})
	require.Nil(t, refusal)
	assert.Equal(t, "default", grant.Mode, "the default is Auto, capped to the caller's Default")
	assert.True(t, grant.ModeFromDefault)
	// the same for Plan
	grant, refusal = capAgentLaunchFor(authOf(rankAsks, nil), agentLaunchAsk{AgentType: "claude", DefaultMode: "auto"})
	require.Nil(t, refusal)
	assert.Equal(t, "default", grant.Mode)
}

func TestAnOrchestratorInAutoStartsAutoMembersAndNeverMore(t *testing.T) {
	grant, refusal := capAgentLaunchFor(authOf(rankJudged, fullCaps), agentLaunchAsk{AgentType: "claude", DefaultMode: "auto"})
	require.Nil(t, refusal)
	assert.Equal(t, "auto", grant.Mode, "its members equal it")
	// a saved default of Bypass is the person's own, and is still capped by the caller
	grant, refusal = capAgentLaunchFor(authOf(rankJudged, fullCaps), agentLaunchAsk{AgentType: "claude", DefaultMode: "bypassPermissions"})
	require.Nil(t, refusal)
	assert.Equal(t, "auto", grant.Mode, "the saved Bypass is capped to the caller's Auto")
	// a caller in Bypass starts Bypass members when that is the default
	grant, refusal = capAgentLaunchFor(authOf(rankOpen, fullCaps), agentLaunchAsk{AgentType: "claude", DefaultMode: "bypassPermissions"})
	require.Nil(t, refusal)
	assert.Equal(t, "bypassPermissions", grant.Mode)
	// a caller at Accept edits gets Accept edits
	grant, refusal = capAgentLaunchFor(authOf(rankEdits, nil), agentLaunchAsk{AgentType: "claude", DefaultMode: "auto"})
	require.Nil(t, refusal)
	assert.Equal(t, "acceptEdits", grant.Mode)
}

func TestAnExplicitRequestAboveTheCallerIsRefusedWithTheReasonAndOneAtOrBelowIsAllowed(t *testing.T) {
	_, refusal := capAgentLaunchFor(authOf(rankJudged, fullCaps), agentLaunchAsk{AgentType: "claude", Flags: []string{"--dangerously-skip-permissions"}, DefaultMode: "auto"})
	require.NotNil(t, refusal, "Bypass from an Auto caller is refused, not clamped")
	assert.Equal(t, agentLaunchAboveCallerCode, refusal.Code)
	assert.Contains(t, refusal.Message, "nothing asks and nothing is sandboxed", "it says what the launch would be")
	assert.Contains(t, refusal.Message, "judged or sandboxed", "and what the caller is")

	_, refusal = capAgentLaunchFor(authOf(rankAsks, nil), agentLaunchAsk{AgentType: "claude", PermissionMode: "auto"})
	require.NotNil(t, refusal, "an explicit Auto from a Default caller")

	grant, refusal := capAgentLaunchFor(authOf(rankJudged, fullCaps), agentLaunchAsk{AgentType: "claude", Flags: []string{"--permission-mode", "acceptEdits", "--model", "opus"}, DefaultMode: "auto"})
	require.Nil(t, refusal, "an explicit request below the caller's rank is allowed")
	assert.Equal(t, "acceptEdits", grant.Mode)
	assert.Equal(t, []string{"--model", "opus"}, grant.Flags, "only --model is passed on as a flag; the mode travels as the mode")
	assert.False(t, grant.ModeFromDefault)

	grant, refusal = capAgentLaunchFor(authOf(rankJudged, fullCaps), agentLaunchAsk{AgentType: "claude", PermissionMode: "default", DefaultMode: "auto"})
	require.Nil(t, refusal)
	assert.Equal(t, "default", grant.Mode, "an explicit Default is Default")
}

func TestAnUnreadablePermissionFlagIsReadAsTheMostOpenAndRefusedUnlessTheCallerIs(t *testing.T) {
	flags := []string{"--ask-for-approval=sometimes-never"}
	_, refusal := capAgentLaunchFor(authOf(rankJudged, fullCaps), agentLaunchAsk{AgentType: "codex", Flags: flags, DefaultMode: "auto"})
	assert.NotNil(t, refusal)
	_, refusal = capAgentLaunchFor(authOf(rankOpen, fullCaps), agentLaunchAsk{AgentType: "codex", Flags: flags, DefaultMode: "auto"})
	assert.Nil(t, refusal, "a caller that has nothing asking can hand the same on")
}

func TestAnAutoOrchestratorCannotStartAnAgyMemberWithFullCapabilities(t *testing.T) {
	_, refusal := capAgentLaunchFor(authOf(rankJudged, fullCaps), agentLaunchAsk{AgentType: "agy", Caps: fullCaps, DefaultMode: "default"})
	require.NotNil(t, refusal, "agy with full capabilities is its yolo (rank 3), whatever the mode word says: the cap is on the effective rank, across types")
	assert.Equal(t, agentLaunchAboveCallerCode, refusal.Code)

	grant, refusal := capAgentLaunchFor(authOf(rankJudged, fullCaps), agentLaunchAsk{AgentType: "agy", DefaultMode: "default"})
	require.Nil(t, refusal, "an agy that names nothing is capped, not refused")
	assert.Equal(t, "default", grant.Mode)
	assert.NotNil(t, grant.Caps, "and gets what the caller's capabilities allow, no more")
}

func TestAHermesOrCodexOrchestratorNeverRaisesAMemberAboveItsOwnTypesSetting(t *testing.T) {
	// Codex in Auto (2) starts Claude members in Auto, not Bypass
	grant, refusal := capAgentLaunchFor(authOf(modeRank("codex", "auto"), nil), agentLaunchAsk{AgentType: "claude", DefaultMode: "bypassPermissions"})
	require.Nil(t, refusal)
	assert.Equal(t, "auto", grant.Mode)
	// Codex at its default (edits) starts Claude members at Accept edits
	grant, refusal = capAgentLaunchFor(authOf(modeRank("codex", "default"), nil), agentLaunchAsk{AgentType: "claude", DefaultMode: "auto"})
	require.Nil(t, refusal)
	assert.Equal(t, "acceptEdits", grant.Mode)
	// a Hermes that asks (rank 0) starts Default members; a Hermes in Bypass (3) may start a Hermes member in Bypass
	grant, refusal = capAgentLaunchFor(authOf(modeRank("hermes", "default"), nil), agentLaunchAsk{AgentType: "claude", DefaultMode: "auto"})
	require.Nil(t, refusal)
	assert.Equal(t, "default", grant.Mode)
	grant, refusal = capAgentLaunchFor(authOf(modeRank("hermes", "default"), nil), agentLaunchAsk{AgentType: "hermes", DefaultMode: "bypassPermissions"})
	require.Nil(t, refusal, "a Hermes member has an ask-first mode, so the cap lowers it")
	assert.Equal(t, "default", grant.Mode, "a Hermes member is rank 3 by default (--yolo), but a caller that asks starts it asking: only a rank-3 caller starts one in Bypass by default")
	grant, refusal = capAgentLaunchFor(authOf(modeRank("hermes", "bypassPermissions"), nil), agentLaunchAsk{AgentType: "hermes", DefaultMode: "bypassPermissions"})
	require.Nil(t, refusal, "only a rank-3 caller starts one by default")
	assert.Equal(t, "bypassPermissions", grant.Mode)
}

func TestATypeThatNeverAsksIsStartedOnlyByACallerThatNeverAsks(t *testing.T) {
	for _, typ := range []string{"pi", "opencode"} {
		_, refusal := capAgentLaunchFor(authOf(rankJudged, fullCaps), agentLaunchAsk{AgentType: typ, DefaultMode: "auto"})
		require.NotNil(t, refusal, typ)
		assert.Equal(t, agentLaunchUnsupervisedCode, refusal.Code, typ)
		_, refusal = capAgentLaunchFor(authOf(rankOpen, fullCaps), agentLaunchAsk{AgentType: typ, DefaultMode: "auto"})
		assert.Nil(t, refusal, typ)
	}
}

func TestACodexThatWouldHaveToAskFirstIsRefusedOnABoardAsBefore(t *testing.T) {
	_, refusal := capAgentLaunchFor(authOf(rankAsks, nil), agentLaunchAsk{AgentType: "codex", OnBoard: true, DefaultMode: "auto"})
	require.NotNil(t, refusal)
	assert.Equal(t, agentLaunchNeedsModeCode, refusal.Code, "the old code and words: a Codex that asks first cannot reach Coral from its sandbox (#7552)")
	assert.Equal(t, agentLaunchNeedsModeMessage, refusal.Message)
	grant, refusal := capAgentLaunchFor(authOf(rankJudged, fullCaps), agentLaunchAsk{AgentType: "codex", OnBoard: true, DefaultMode: "auto"})
	require.Nil(t, refusal)
	assert.Equal(t, "auto", grant.Mode)
}

func TestCapabilitiesAreCappedTheSameWay(t *testing.T) {
	narrow := &agent.Capabilities{Allow: []string{"file_read", "shell:coral-board *"}, Deny: []string{"web_access"}}
	// an Orchestrator with a narrow list cannot hand out a full one
	_, refusal := capAgentLaunchFor(authOf(rankJudged, narrow), agentLaunchAsk{AgentType: "claude", Caps: fullCaps, DefaultMode: "auto"})
	require.NotNil(t, refusal)
	assert.Equal(t, agentLaunchAboveCallerCode, refusal.Code)
	assert.Contains(t, refusal.Message, "capability")
	// a read-only role cannot start a writing one
	_, refusal = capAgentLaunchFor(authOf(rankJudged, &agent.Capabilities{Allow: []string{"file_read"}}), agentLaunchAsk{AgentType: "claude", Caps: &agent.Capabilities{Allow: []string{"file_read", "file_write"}}, DefaultMode: "auto"})
	require.NotNil(t, refusal)
	// a subset is allowed, and carries the caller's deny list
	grant, refusal := capAgentLaunchFor(authOf(rankJudged, narrow), agentLaunchAsk{AgentType: "claude", Caps: &agent.Capabilities{Allow: []string{"file_read"}, Deny: []string{"git_write"}}, DefaultMode: "auto"})
	require.Nil(t, refusal)
	assert.Equal(t, []string{"file_read"}, grant.Caps.Allow)
	assert.ElementsMatch(t, []string{"web_access", "git_write"}, grant.Caps.Deny, "the caller's deny list is in the member's")
	// none asked for: the member gets the caller's
	grant, refusal = capAgentLaunchFor(authOf(rankJudged, narrow), agentLaunchAsk{AgentType: "claude", DefaultMode: "auto"})
	require.Nil(t, refusal)
	assert.Equal(t, narrow.Allow, grant.Caps.Allow)
	assert.Equal(t, narrow.Deny, grant.Caps.Deny)
	// a caller that carries no capabilities cannot hand out an allow list, and a full-capability Orchestrator can
	_, refusal = capAgentLaunchFor(authOf(rankJudged, nil), agentLaunchAsk{AgentType: "claude", Caps: &agent.Capabilities{Allow: []string{"shell"}}, DefaultMode: "auto"})
	require.NotNil(t, refusal)
	grant, refusal = capAgentLaunchFor(authOf(rankJudged, fullCaps), agentLaunchAsk{AgentType: "claude", Caps: &agent.Capabilities{Allow: []string{"file_read", "shell:go test *"}}, DefaultMode: "auto"})
	require.Nil(t, refusal, "a bare shell covers a shell pattern")
	assert.Contains(t, grant.Caps.Allow, "shell:go test *")
}

func TestToolsAndHooksBeyondTheCallersAreRefused(t *testing.T) {
	_, refusal := capAgentLaunchFor(authOf(rankJudged, fullCaps), agentLaunchAsk{AgentType: "claude", Hooks: map[string]interface{}{"PreToolUse": "x"}, DefaultMode: "auto"})
	require.NotNil(t, refusal, "hooks run commands: none from an agent")
	_, refusal = capAgentLaunchFor(authOf(rankJudged, fullCaps), agentLaunchAsk{AgentType: "claude", Tools: []string{"Bash(*)"}, DefaultMode: "auto"})
	require.NotNil(t, refusal, "a tool the caller does not have")
	caller := callerAuthority{Rank: rankJudged, Caps: fullCaps, Tools: []string{"Bash(go test *)"}}
	_, refusal = capAgentLaunchFor(caller, agentLaunchAsk{AgentType: "claude", Tools: []string{"Bash(go test *)"}, DefaultMode: "auto"})
	assert.Nil(t, refusal, "a tool the caller has is allowed")
}

func TestASavedTemplateMemberKeepsItsOwnChoicesButItsDefaultModeIsStillCapped(t *testing.T) {
	grant, refusal := capAgentLaunchFor(authOf(rankAsks, nil), agentLaunchAsk{AgentType: "claude", SavedTemplate: true, Caps: fullCaps, Tools: []string{"Bash(*)"}, Flags: []string{"--model", "opus", "--verbose"}, DefaultMode: "auto"})
	require.Nil(t, refusal, "the Operator saved it: its capabilities and tools are kept (#4032)")
	assert.Equal(t, fullCaps, grant.Caps)
	assert.Equal(t, []string{"Bash(*)"}, grant.Tools)
	assert.Equal(t, "default", grant.Mode, "a template stores no mode: the member's default is capped by the caller")
}

func TestAnUnknownCallerAndARowWithNoModeAreRankZero(t *testing.T) {
	assert.Equal(t, rankAsks, authorityFromRow(nil, false).Rank, "an unknown or unverified caller")
	assert.Equal(t, rankAsks, authorityFromRow(&store.LiveSession{AgentType: "claude"}, false).Rank, "a row that records no mode")
	auto, bypass := "auto", "bypassPermissions"
	assert.Equal(t, rankJudged, authorityFromRow(&store.LiveSession{AgentType: "claude", PermissionMode: &auto}, false).Rank)
	assert.Equal(t, rankOpen, authorityFromRow(&store.LiveSession{AgentType: "claude", PermissionMode: &bypass}, false).Rank)
	assert.Equal(t, rankOpen, authorityFromRow(&store.LiveSession{AgentType: "claude"}, true).Rank, "Keep Full access is the top")
	assert.Equal(t, rankOpen, authorityFromRow(&store.LiveSession{AgentType: "claude", Flags: store.MarshalFlags([]string{"--dangerously-skip-permissions"})}, false).Rank, "the mode read from its stored flags")
	_, refusal := capAgentLaunchFor(callerAuthority{}, agentLaunchAsk{AgentType: "claude", PermissionMode: "auto", DefaultMode: "auto"})
	assert.NotNil(t, refusal)
	grant, refusal := capAgentLaunchFor(callerAuthority{}, agentLaunchAsk{AgentType: "claude", DefaultMode: "auto"})
	require.Nil(t, refusal)
	assert.Equal(t, "default", grant.Mode, "an unknown caller starts Default members")
}
