package agent

import "strings"

// What a permission mode and a capability set each allow, and the narrower of the two (#6425, Security's rule): an explicit mode is always applied and capabilities only narrow it for
// the CLIs that keep only a sandbox and an approval mode (Codex, Antigravity). Claude keeps the lists and the mode apart.

const codexSandboxNone = "danger-full-access"

// codexPair is Codex's sandbox and approval policy as they are put on the command line; "" is "not set".
type codexPair struct{ sandbox, approval string }

func codexSandboxRank(s string) int {
	switch s {
	case "read-only":
		return 1
	case "workspace-write":
		return 2
	case codexSandboxNone:
		return 3
	}
	return 2 // not set: Codex's own default is workspace-write
}

func codexApprovalRank(a string) int {
	if a == "never" {
		return 2
	}
	return 1 // on-request, and what is not set (it asks)
}

// codexPairOf is the pair the capabilities stand for.
func codexPairOf(perms *CodexPermissions) codexPair {
	switch {
	case perms.FullAuto:
		return codexPair{"workspace-write", "never"}
	}
	return codexPair{perms.SandboxMode, perms.ApprovalPolicy}
}

// codexPairForMode is the pair an explicit mode stands for; false for "" and "default" (the CLI's confirm mode is no explicit choice) and for a mode Codex has nothing for.
func codexPairForMode(mode string) (codexPair, bool) {
	switch mode {
	case "plan":
		return codexPair{"read-only", "on-request"}, true
	case "acceptEdits":
		return codexPair{"workspace-write", "on-request"}, true
	case "auto", "dontAsk":
		return codexPair{"workspace-write", "never"}, true
	case "bypassPermissions":
		return codexPair{codexSandboxNone, "never"}, true
	}
	return codexPair{}, false
}

// narrowCodexPair is the narrower sandbox and the narrower approval of the two.
func narrowCodexPair(a, b codexPair) codexPair {
	out := a
	if codexSandboxRank(b.sandbox) < codexSandboxRank(a.sandbox) {
		out.sandbox = b.sandbox
	}
	if codexApprovalRank(b.approval) < codexApprovalRank(a.approval) {
		out.approval = b.approval
	}
	return out
}

// Antigravity keeps one mode, widest to narrowest: nothing asks (--dangerously-skip-permissions), accept-edits, plan, and the default that asks before acting.
const (
	agyRankDefault = iota
	agyRankPlan
	agyRankAcceptEdits
	agyRankAuto // --mode auto: judged by agy's own safety gate, between accept-edits and nothing asking (#14741)
	agyRankSkip
)

func agyRankForMode(mode string) (int, bool) {
	switch mode {
	case "plan", "dontAsk":
		return agyRankPlan, true
	case "acceptEdits":
		return agyRankAcceptEdits, true
	case "auto":
		return agyRankAuto, true // not the skip flag: auto is its own mode (#14741, Security: auto never silently becomes Bypass)
	case "bypassPermissions":
		return agyRankSkip, true
	}
	return 0, false
}

func agyRankOf(p *AgyPermissions) int {
	switch {
	case p.DangerouslySkipPermissions:
		return agyRankSkip
	case p.Mode == "accept-edits":
		return agyRankAcceptEdits
	case p.Mode == "auto":
		return agyRankAuto
	case p.Mode == "plan":
		return agyRankPlan
	}
	return agyRankDefault
}

// narrowAgyPermissions is the explicit mode's rank, or the capabilities' when that is narrower. Shell and Write with no deny (skip permissions) restrict nothing, so the mode stands.
func narrowAgyPermissions(caps *AgyPermissions, mode int) *AgyPermissions {
	rank := agyRankOf(caps)
	if caps.DangerouslySkipPermissions || rank > mode {
		rank = mode
	}
	out := &AgyPermissions{Sandbox: caps.Sandbox}
	switch rank {
	case agyRankSkip:
		out.DangerouslySkipPermissions = true
	case agyRankAcceptEdits:
		out.Mode = "accept-edits"
	case agyRankAuto:
		out.Mode = "auto"
	case agyRankPlan:
		out.Mode = "plan"
	}
	return out
}

// CodexLaunchPermissions is the sandbox and the approval policy a Codex launch with these stored settings runs with: the flags, the capabilities and the permission mode go through the same
// steps the launch builder takes (capabilities first, then the stored flags, then the mode), and the permission flags that come out are read back as a pair. It is what a wake, a restart
// or an auto-wake would give the agent, to be compared with the mode it runs in now (#14051). "" and "" when the settings carry no permission at all: the CLI's own config decides then,
// and nothing can be said to be narrower or wider. With the Operator's keepFullAccess it is Full access whatever the rest says.
func CodexLaunchPermissions(flags []string, caps *Capabilities, mode string, keepFullAccess bool) (sandbox, approval string) {
	if keepFullAccess { // the Operator's choice (#14061): every relaunch is the bypass switch
		return codexSandboxNone, "never"
	}
	parts, bypass, applied := codexCapabilityFlags(nil, caps, mode)
	presetApplied := applied
	parts, bypass, applied = codexUserFlags(parts, flags, bypass, applied)
	if !applied {
		parts, _, _ = appendCodexPermissionMode(parts, bypass, mode)
	}
	parts = collapseCodexSandboxFlags(parts, presetApplied)
	for i := 0; i < len(parts); i++ {
		switch {
		case parts[i] == "--dangerously-bypass-approvals-and-sandbox":
			sandbox, approval = codexSandboxNone, "never"
		case (parts[i] == "-c" || parts[i] == "--config") && i+1 < len(parts):
			i++
			key, value, _ := strings.Cut(parts[i], "=")
			value = strings.Trim(value, `"'`)
			switch key {
			case "sandbox_mode":
				sandbox = value
			case "approval_policy":
				approval = normalizeCodexApprovalPolicy(value)
			}
		default:
			kind, n := codexPermissionFlag(parts, i)
			if n == 0 {
				continue
			}
			value := parts[i+n-1]
			if n == 1 { // the = form
				_, value, _ = strings.Cut(parts[i], "=")
			}
			if kind == 's' {
				sandbox = value
			} else {
				approval = normalizeCodexApprovalPolicy(value)
			}
			i += n - 1
		}
	}
	return sandbox, approval
}

// CodexModeNote says, in the person's words, when what Codex is started with is not what the chosen mode stands for, and why: Full access kept for the agent, a capability set that narrows
// the mode (#6425), or capabilities that set the flags because the pick is Default (#6422). "" when the mode's own flags are what runs (and for a pick Codex has no flags for). The flags
// themselves come from LaunchCommand: this is the reason beside them (#15727, for New agent's flags line).
func CodexModeNote(caps *Capabilities, mode string, keepFull bool) string {
	if keepFull {
		return "Full access is kept for this agent, so it starts with no sandbox and no approvals whatever its mode and capabilities say."
	}
	perms := TranslateToCodexPermissions(caps)
	if perms == nil {
		return ""
	}
	capPair := codexPairOf(perms)
	if perms.FullAuto {
		capPair = codexPair{"workspace-write", "never"}
	}
	m, explicit := codexPairForMode(mode)
	if !explicit {
		return "Default has no flags of its own, so the agent's capabilities set them: " + codexPairWords(capPair) + "."
	}
	if perms.FullAuto {
		return "" // against an explicit mode, Shell with no limits restricts nothing: the mode stands as chosen
	}
	if narrowCodexPair(m, capPair) == m {
		return ""
	}
	return "The agent's capabilities narrow this mode to " + codexPairWords(narrowCodexPair(m, capPair)) + "."
}

func codexPairWords(p codexPair) string {
	approval := "asks first"
	if p.approval == "never" {
		approval = "never asks"
	}
	switch p.sandbox {
	case "read-only":
		return "read-only, " + approval
	case "workspace-write", "":
		return "workspace writes, " + approval
	case codexSandboxNone:
		return "no sandbox, " + approval
	}
	return p.sandbox + ", " + approval
}
