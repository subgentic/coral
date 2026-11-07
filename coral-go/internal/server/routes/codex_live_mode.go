package routes

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/store"
)

// The live mode of a Codex agent (#14051). A person can widen what a Codex agent may do inside Codex itself (Full access); Coral never hears of it, and every relaunch (Wake, Restart, an
// auto-wake, a resume in the same terminal) starts the CLI again with the stored launch settings. So a row says two things, both for the person to read and neither ever used to decide
// anything (the rollout is written by the agent's own process): the mode the newest turn ran in, and, when a relaunch would give it something narrower, what each would be.

// codexModeLabel says a mode in the person's words; "" for what is not known.
func codexModeLabel(approval, sandbox string) string {
	switch {
	case sandbox == "danger-full-access" && approval == "never":
		return "Full access"
	case sandbox == "danger-full-access" && approval != "":
		return "Full access, asks first"
	case sandbox == "danger-full-access":
		return "Full access"
	case sandbox == "read-only":
		return "Read-only"
	case sandbox == "workspace-write" && approval == "never":
		return "Workspace write, never asks"
	case sandbox == "workspace-write" && approval != "":
		return "Workspace write, asks when needed"
	case sandbox == "workspace-write":
		return "Workspace write"
	case sandbox == "external-sandbox":
		return "Runs in an outside sandbox"
	case approval == "never":
		return "Never asks"
	case approval != "":
		return "Asks when needed"
	}
	return ""
}

func codexSandboxRank(sandbox string) int {
	switch sandbox {
	case "read-only":
		return 1
	case "workspace-write":
		return 2
	case "danger-full-access":
		return 3
	}
	return 0 // unknown, or an outside sandbox: not compared
}

func codexApprovalRank(approval string) int {
	switch approval {
	case "on-request", "untrusted", "on-failure":
		return 1
	case "never":
		return 2
	}
	return 0
}

// codexNarrows says whether the launch pair gives LESS than the live pair: narrower in the sandbox or in the approval policy and wider in neither (only what both sides know is compared). A
// mix (a relaunch asks where it did not, and may write where it could not) is not called narrower: the two modes are then different, not one inside the other, and a warning would mislead.
func codexNarrows(liveSandbox, liveApproval, launchSandbox, launchApproval string) bool {
	narrower := false
	for _, d := range [][2]int{
		{codexSandboxRank(liveSandbox), codexSandboxRank(launchSandbox)},
		{codexApprovalRank(liveApproval), codexApprovalRank(launchApproval)},
	} {
		live, launch := d[0], d[1]
		if live == 0 || launch == 0 {
			continue
		}
		if launch > live {
			return false
		}
		if launch < live {
			narrower = true
		}
	}
	return narrower
}

// codexLaunchPair is what a relaunch of the row would run with: the stored flags, capabilities and permission mode through the launch builder's own steps.
func codexLaunchPair(flags, capabilities, mode *string, keepFullAccess bool) (sandbox, approval string) {
	var caps *agent.Capabilities
	if capabilities != nil && *capabilities != "" {
		c := &agent.Capabilities{}
		if json.Unmarshal([]byte(*capabilities), c) == nil {
			caps = c
		}
	}
	return agent.CodexLaunchPermissions(store.UnmarshalFlags(flags), caps, ptr.Value(mode), keepFullAccess)
}

// codexModeFields are the two row keys: the live mode ({approval, sandbox, label}, nil when there is no turn_context to read) and the narrowing ({live, launch}, nil unless a relaunch would give
// less than the live mode). Both nil for any agent but Codex. A launch with no permission stored says nothing (the CLI's own config decides, so it cannot be called narrower).
func (h *SessionsHandler) codexModeFields(agentType, sid, workingDir string, extra liveExtra) (live, narrows any) {
	if agentType != "codex" || h.jsonl == nil {
		return nil, nil
	}
	approval, sandbox := h.jsonl.ReadCodexLiveMode(sid, workingDir)
	label := codexModeLabel(approval, sandbox)
	if label == "" {
		return nil, nil
	}
	live = map[string]any{"approval": approval, "sandbox": sandbox, "label": label}
	launchSandbox, launchApproval := codexLaunchPair(extra.Flags, extra.Capabilities, extra.PermissionMode, extra.KeepFull)
	if codexNarrows(sandbox, approval, launchSandbox, launchApproval) {
		narrows = map[string]any{"live": label, "launch": codexModeLabel(launchApproval, launchSandbox)}
	}
	return live, narrows
}

// relaunchNarrowing says, for a stored row about to be relaunched, what its Codex ran with and what the relaunch will give it, when that is less: the live mode and the launch set in the
// person's words ("" and "" when not). It reads the rollout before the relaunch, so it is what the agent ran with, display only.
func (h *SessionsHandler) relaunchNarrowing(ls store.LiveSession) (live, launch string) {
	if ls.AgentType != "codex" || h.jsonl == nil {
		return "", ""
	}
	approval, sandbox := h.jsonl.ReadCodexLiveMode(ls.SessionID, ls.WorkingDir)
	label := codexModeLabel(approval, sandbox)
	if label == "" {
		return "", ""
	}
	keep, _ := h.ss.KeepFullAccess(context.Background(), ls.SessionID)
	launchSandbox, launchApproval := codexLaunchPair(ls.Flags, ls.Capabilities, ls.PermissionMode, keep)
	if !codexNarrows(sandbox, approval, launchSandbox, launchApproval) {
		return "", ""
	}
	return label, codexModeLabel(launchApproval, launchSandbox)
}

// relaunchNarrowedSentence is the sentence a woken Codex agent's board gets (#14051). Only the two mode names from codexModeLabel are in it: a fixed set of words, nothing the agent's rollout wrote.
func relaunchNarrowedSentence(live, launch string) string {
	return "You ran with " + live + "; Coral started Codex again with " + launch + ", the settings you were launched with. A mode set inside Codex is not kept when Codex starts again: if you need " + live + ", ask the person to set it in Codex (/permissions)."
}

// postRelaunchNarrowed puts that sentence on the agent's own board, addressed to it, once per wake. A restart-time wake adds it to its notice instead (sendAutoWakeNotice).
func (h *SessionsHandler) postRelaunchNarrowed(ctx context.Context, ls store.LiveSession, live, launch string) {
	if live == "" || h.bs == nil || ptr.Value(ls.BoardName) == "" {
		return
	}
	title := h.noticeName(ctx, ls)
	if title == "" {
		return
	}
	if _, err := h.bs.PostSystemMessage(ctx, ptr.Value(ls.BoardName), board.CoralSender, "@"+title+" "+relaunchNarrowedSentence(live, launch), nil); err != nil {
		slog.Warn("could not post an agent's narrowed relaunch to its board", "session_id", ls.SessionID, "error", err)
	}
}
