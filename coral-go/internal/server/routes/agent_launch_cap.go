// What an agent may start another agent as: one rank for "what it can do without asking", and the cap an agent's launch is held to (#14336, Security's ruling on #14333, MUST 1).
//
// Before, an agent's launch kept only --model and lost every allow rule (limitAgentLaunch), was refused when the saved default skipped prompts or when the type never asks, and an Orchestrator's launch
// started ask-first (#4032, #5901, #7576, #11713, #7552). With the new default (a team member that names nothing starts in Auto with full capabilities) those four guards could not stay as they were,
// and they must not simply go: an agent still never starts an agent that can do more without asking than itself. This file is the one function they became (capAgentLaunchFor); the old guards' tests
// keep their names and were rewritten for the cap.

package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/store"
)

// The rank: what an agent can do without asking, on one scale, worked out AFTER its type's own translation of a mode and of capabilities (Security's ruling on #14333). It is the member's effective
// rank that is capped, not the mode's name, and it applies across types: an Auto Claude Orchestrator (2) cannot start an agy with full capabilities (3).
const (
	rankAsks   = 0 // asks for everything: Default, Plan
	rankEdits  = 1 // edits without asking: Accept edits, agy accept-edits, Codex's workspace-write on request
	rankJudged = 2 // judged or sandboxed: Claude Auto with its allow rules, Codex workspace-write that never asks
	rankOpen   = 3 // nothing asks and nothing is sandboxed: Bypass, Hermes --yolo, agy's yolo, a type that never asks (Pi, opencode), Keep Full access
)

// Codes of an agent launch refused by the cap. The first two are the codes the old guards used, kept so a client that knew them still reads them.
const (
	agentLaunchAboveCallerCode = "agent_launch_above_caller" // the launch asks for more than the agent that makes it has
)

func isAgyType(agentType string) bool {
	return agentType == at.Agy || agentType == at.Antigravity || agentType == at.Gemini
}

// modeRank is the rank of a permission mode as the type's CLI takes it. "" is no mode named.
func modeRank(agentType, mode string) int {
	if agentType == at.Pi || agentType == at.Opencode {
		return rankOpen // no mode of theirs asks (agent.SkipsPermissionPrompts)
	}
	switch {
	case agentType == at.Codex:
		switch mode {
		case "bypassPermissions":
			return rankOpen
		case "auto", "dontAsk":
			return rankJudged // --sandbox workspace-write -a never
		case "plan":
			return rankAsks // --sandbox read-only
		default: // default, acceptEdits and none: --sandbox workspace-write -a on-request
			return rankEdits
		}
	case agentType == at.Hermes:
		if mode == "bypassPermissions" {
			return rankOpen // --yolo: no prompt and no sandbox of any kind (the only mode Hermes has above asking)
		}
		return rankAsks
	case isAgyType(agentType):
		switch mode {
		case "bypassPermissions":
			return rankOpen
		case "acceptEdits":
			return rankEdits
		default: // "auto" and "dontAsk" have no flag for agy: they ask
			return rankAsks
		}
	}
	switch mode { // Claude, and a type nobody listed (read like Claude's: the stricter reading is the lower one only for modes it does not know)
	case "bypassPermissions":
		return rankOpen
	case "auto", "dontAsk":
		return rankJudged
	case "acceptEdits":
		return rankEdits
	default:
		return rankAsks
	}
}

// capsRank is the rank the capabilities give an agy or Codex after the translation to the CLI's own flags (TranslateToAgyPermissions, TranslateToCodexPermissions): the other types read capabilities as
// allow rules and a mode, which the subset rule below caps separately. ok is false when the capabilities say nothing of rank.
func capsRank(agentType string, caps *agent.Capabilities) (rank int, ok bool) {
	if caps.IsEmpty() {
		return 0, false
	}
	switch {
	case isAgyType(agentType):
		p := agent.TranslateToAgyPermissions(caps)
		switch {
		case p == nil:
			return 0, false
		case p.DangerouslySkipPermissions:
			return rankOpen, true // full capabilities are agy's yolo
		case p.Mode == "accept-edits":
			return rankEdits, true
		default:
			return rankAsks, true
		}
	case agentType == at.Codex:
		p := agent.TranslateToCodexPermissions(caps)
		switch {
		case p == nil:
			return 0, false
		case p.FullAuto:
			return rankJudged, true // never to no-sandbox (#6422): that comes only from Bypass or Keep Full access
		case p.SandboxMode == "read-only":
			return rankAsks, true
		default:
			return rankEdits, true
		}
	}
	return 0, false
}

// effectiveRank is the rank of a launch with this mode, capabilities and Keep Full access. Capabilities only narrow an explicit mode (#6425); with no mode named they are the rank (agy's yolo from
// full capabilities). Keep Full access is the top of the scale.
func effectiveRank(agentType, mode string, caps *agent.Capabilities, keepFull bool) int {
	if keepFull {
		return rankOpen
	}
	r := modeRank(agentType, mode)
	if cr, ok := capsRank(agentType, caps); ok {
		switch mode {
		case "", "default", "auto", "dontAsk":
			if isAgyType(agentType) || mode == "" || mode == "default" {
				r = cr
			} else if cr < r {
				r = cr
			}
		default:
			if cr < r {
				r = cr
			}
		}
	}
	return r
}

// modeForRank is the strongest mode of the type whose rank is at most max, "" when the type has none (a Codex that would have to ask has none usable on a board: it could not reach Coral; Pi and opencode
// never ask, so only rank 3 starts them).
func modeForRank(agentType string, max int) (string, bool) {
	if agentType == at.Pi || agentType == at.Opencode {
		return "bypassPermissions", max >= rankOpen
	}
	type cand struct {
		mode string
		rank int
	}
	var ladder []cand
	switch {
	case agentType == at.Codex:
		ladder = []cand{{"plan", rankAsks}, {"acceptEdits", rankEdits}, {"auto", rankJudged}, {"bypassPermissions", rankOpen}}
	case agentType == at.Hermes:
		ladder = []cand{{"default", rankAsks}, {"bypassPermissions", rankOpen}}
	case isAgyType(agentType):
		ladder = []cand{{"default", rankAsks}, {"acceptEdits", rankEdits}, {"bypassPermissions", rankOpen}}
	default:
		ladder = []cand{{"default", rankAsks}, {"acceptEdits", rankEdits}, {"auto", rankJudged}, {"bypassPermissions", rankOpen}}
	}
	best, found := "", false
	for _, c := range ladder {
		if c.rank <= max {
			best, found = c.mode, true
		}
	}
	return best, found
}

// callerAuthority is what the launching agent has, read from ITS STORED ROW on the server for the verified token's session, never from the request: its rank, its capabilities and its tools. An unknown
// or unverified caller, and a row that records no mode, has rank 0 and no capabilities.
type callerAuthority struct {
	Rank  int
	Caps  *agent.Capabilities
	Tools []string
}

// authorityFromRow works out the authority of the agent that has this stored row. keepFull is its Keep Full access (the Operator's, from the keep_full_access table).
func authorityFromRow(ls *store.LiveSession, keepFull bool) callerAuthority {
	if ls == nil {
		return callerAuthority{}
	}
	mode := ""
	if ls.PermissionMode != nil && agent.ValidPermissionMode(*ls.PermissionMode) {
		mode = *ls.PermissionMode
	}
	flags := store.UnmarshalFlags(ls.Flags)
	if mode == "" {
		mode = agent.PermissionModeFromFlags(flags)
	}
	if mode == "" && ls.AgentType == at.Codex && agent.CodexFlagsAreAuto(flags) {
		mode = "auto"
	}
	var caps *agent.Capabilities
	if ls.Capabilities != nil && *ls.Capabilities != "" {
		caps = &agent.Capabilities{}
		if err := unmarshalCaps(*ls.Capabilities, caps); err != nil {
			caps = nil // unreadable: no authority over capabilities
		}
	}
	a := callerAuthority{Caps: caps, Tools: store.UnmarshalFlags(ls.Tools)}
	if mode == "" && !keepFull {
		return a // a row that records no mode: unknown, rank 0 (fail closed)
	}
	a.Rank = effectiveRank(ls.AgentType, mode, caps, keepFull)
	return a
}

// agentLaunchAsk is what an agent's launch of ONE agent asks for.
type agentLaunchAsk struct {
	AgentType      string
	Flags          []string
	PermissionMode string // the request's own, which only ever says "default"
	Caps           *agent.Capabilities
	Tools          []string
	Hooks          map[string]interface{}
	OnBoard        bool
	// SavedTemplate: the member is exactly an entry of a team template the Operator saved (inSavedTeamTemplate): its explicit flags, capabilities, tools and hooks are the Operator's choice and are kept
	// (#4032); the mode it starts in is still capped, because a template stores no mode.
	SavedTemplate bool
	// DefaultMode is what the member starts in when it names no mode: the Operator's saved default_permission_mode, else the shipped default of its type.
	DefaultMode string
}

// agentLaunchGrant is what the cap lets the launch have.
type agentLaunchGrant struct {
	Flags           []string // only --model, as before (every other word is dropped, in any spelling), plus nothing that carries a mode: the mode is Mode
	Mode            string   // the permission mode the member starts in, "" for none named
	Caps            *agent.Capabilities
	Tools           []string
	Hooks           map[string]interface{}
	ModeFromDefault bool // the mode was not asked for: it is the default, capped
}

// agentLaunchRefusal is a launch the cap refuses, with the code and words the person sees.
type agentLaunchRefusal struct {
	Code    string
	Message string
}

func rankWords(rank int) string {
	switch rank {
	case rankOpen:
		return "nothing asks and nothing is sandboxed"
	case rankJudged:
		return "judged or sandboxed (Auto)"
	case rankEdits:
		return "edits without asking"
	}
	return "asks for everything"
}

// capAgentLaunchFor is THE rule for every route that starts an agent for an agent caller (launch, launch-team): the member gets the lower of the new default for its type and the caller's rank; an
// explicit request above the caller's rank is refused with the reason, never clamped (so an agent cannot learn the cap by probing, and the person sees why); one at or below is allowed; capabilities
// are a subset of the caller's allow list and carry the caller's deny list; tools and hooks beyond the caller's own are refused (#14336, Security's ruling on #14333, points 1 to 4).
func capAgentLaunchFor(auth callerAuthority, ask agentLaunchAsk) (agentLaunchGrant, *agentLaunchRefusal) {
	grant := agentLaunchGrant{Flags: keepAgentLaunchFlags(ask.Flags)}
	if ask.SavedTemplate {
		grant.Flags = ask.Flags // the Operator's own saved flags, as saved (#4032)
	}
	typ := ask.AgentType

	// What the request asks for in the way of a mode: its own field or its permission flags. A permission flag nobody here can read as a mode is read as the most open: it is refused unless the caller is.
	flagMode := agent.PermissionModeFromFlags(ask.Flags)
	if flagMode == "" && typ == at.Codex && agent.CodexFlagsAreAuto(ask.Flags) {
		flagMode = "auto"
	}
	carried, _ := agent.SplitPermissionFlags(ask.Flags)
	unreadable := flagMode == "" && len(carried) > 0
	explicit := ask.PermissionMode
	if explicit == "" {
		explicit = flagMode
	}
	if explicit != "" && !agent.ValidPermissionMode(explicit) {
		return grant, &agentLaunchRefusal{agentLaunchAboveCallerCode, "the permission mode asked for is not one this agent's type has"}
	}

	if !ask.SavedTemplate {
		// Tools and hooks (commands the agent's CLI would run itself) beyond the caller's own are refused. An agent's hooks are not kept on its row, so none are allowed.
		if len(ask.Hooks) > 0 {
			return grant, &agentLaunchRefusal{agentLaunchAboveCallerCode, "an agent cannot start an agent with hooks: they run commands, and only the Operator can start a less-restricted agent"}
		}
		if !toolsWithin(ask.Tools, auth.Tools) {
			return grant, &agentLaunchRefusal{agentLaunchAboveCallerCode, "an agent cannot start an agent with allowed tools it does not have itself"}
		}
	} else {
		grant.Tools, grant.Hooks = ask.Tools, ask.Hooks
	}

	// An explicit mode, or capabilities that translate to a rank of their own (agy, Codex), against the caller's rank.
	askRank, asked := 0, false
	switch {
	case unreadable:
		askRank, asked = rankOpen, true
	case explicit != "":
		askRank, asked = effectiveRank(typ, explicit, ask.Caps, false), true
	default:
		if cr, ok := capsRank(typ, ask.Caps); ok && !ask.SavedTemplate {
			askRank, asked = cr, true
		}
	}
	if asked && !ask.SavedTemplate && askRank > auth.Rank {
		return grant, &agentLaunchRefusal{agentLaunchAboveCallerCode, fmt.Sprintf("an agent cannot start a %s agent that can do more without asking than itself: this one would be %s, and the agent that starts it is %s; ask the Operator to start it", typ, rankWords(askRank), rankWords(auth.Rank))}
	}

	switch {
	case unreadable && ask.SavedTemplate:
		// the Operator's saved flags carry a permission flag nobody here can read as a mode: handed on as saved, never read as a mode of ours
	case explicit != "":
		grant.Mode = explicit
	case ask.SavedTemplate:
		// A saved member that names no mode starts in the default, capped below.
		fallthrough
	default:
		def := ask.DefaultMode
		if def == "" || !agent.ValidPermissionMode(def) {
			def = agent.DefaultLaunchPermissionMode(typ)
		}
		want := effectiveRank(typ, def, nil, false)
		if want > auth.Rank {
			want = auth.Rank
		}
		mode, ok := modeForRank(typ, want)
		if !ok && ask.SavedTemplate && (typ == at.Pi || typ == at.Opencode) {
			break // the Operator's own saved member of a type that never asks: it starts as saved (#5901's exception), with no mode of ours
		}
		if !ok {
			return grant, &agentLaunchRefusal{codeForNoMode(typ), messageForNoMode(typ, ask.OnBoard)}
		}
		if typ == at.Codex && ask.OnBoard && modeRank(typ, mode) < rankEdits {
			return grant, &agentLaunchRefusal{agentLaunchNeedsModeCode, agentLaunchNeedsModeMessage} // a Codex that asks first cannot reach Coral from its sandbox (#7552)
		}
		grant.Mode, grant.ModeFromDefault = mode, true
	}
	if grant.Mode != "" && typ != at.Pi && typ != at.Opencode && modeRank(typ, grant.Mode) > auth.Rank && !ask.SavedTemplate {
		return grant, &agentLaunchRefusal{agentLaunchAboveCallerCode, "an agent cannot start an agent that can do more without asking than itself"} // never reached when the rules above hold: the cap's last line
	}

	// Capabilities: a subset of the caller's allow list, carrying the caller's deny list.
	if !ask.SavedTemplate {
		caps, refusal := capCapabilities(ask.Caps, auth.Caps)
		if refusal != nil {
			return grant, refusal
		}
		grant.Caps = caps
	} else {
		grant.Caps = ask.Caps
	}
	return grant, nil
}

func codeForNoMode(typ string) string {
	if typ == at.Codex {
		return agentLaunchNeedsModeCode
	}
	return agentLaunchUnsupervisedCode
}

func messageForNoMode(typ string, onBoard bool) string {
	if typ == at.Codex {
		return agentLaunchNeedsModeMessage
	}
	return agentLaunchUnsupervisedMessage(typ)
}

// toolsWithin reports whether every tool asked for is one the caller has.
func toolsWithin(asked, have []string) bool {
	set := map[string]bool{}
	for _, t := range have {
		set[t] = true
	}
	for _, t := range asked {
		if !set[t] {
			return false
		}
	}
	return true
}

// capCapabilities holds a member's capabilities to the caller's: the allow list a subset of the caller's (a bare shell covers a shell:<pattern>), the deny list the caller's plus its own. With none asked
// for the member gets the caller's (the new default's full set, limited to what the caller has).
func capCapabilities(asked, caller *agent.Capabilities) (*agent.Capabilities, *agentLaunchRefusal) {
	allow := map[string]bool{}
	if caller != nil {
		for _, a := range caller.Allow {
			allow[a] = true
		}
	}
	covered := func(a string) bool {
		if allow[a] {
			return true
		}
		return strings.HasPrefix(a, "shell:") && allow["shell"]
	}
	out := &agent.Capabilities{}
	if caller != nil {
		out.Deny = append(out.Deny, caller.Deny...)
	}
	if asked.IsEmpty() {
		if caller != nil {
			out.Allow = append(out.Allow, caller.Allow...)
		}
	} else {
		for _, a := range asked.Allow {
			if !covered(a) {
				return nil, &agentLaunchRefusal{agentLaunchAboveCallerCode, "an agent cannot start an agent with a capability it does not have itself (" + a + ")"}
			}
		}
		out.Allow = append(out.Allow, asked.Allow...)
		for _, d := range asked.Deny {
			dup := false
			for _, have := range out.Deny {
				if have == d {
					dup = true
				}
			}
			if !dup {
				out.Deny = append(out.Deny, d)
			}
		}
	}
	if out.IsEmpty() {
		return nil, nil
	}
	return out, nil
}

// callerAuthority reads the verified caller's authority from its stored row, and its Keep Full access (the Operator's choice, which is the top of the rank). An unreadable row is rank 0.
func (h *SessionsHandler) callerAuthorityOf(ctx context.Context, r *http.Request) callerAuthority {
	owner, ok := VerifiedSession(r.Context())
	if !ok || owner == nil || h.ss == nil {
		return callerAuthority{}
	}
	ls, err := h.ss.GetLiveSession(ctx, owner.SessionID)
	if err != nil || ls == nil {
		return callerAuthority{}
	}
	keep, kerr := h.ss.KeepFullAccess(ctx, owner.SessionID)
	if kerr != nil {
		keep = false // an unreadable choice cannot raise the caller's rank
	}
	return authorityFromRow(ls, keep)
}

// defaultModeFor is what a launch of the type that names no mode starts in: the Operator's saved default_permission_mode, else the shipped default of the type.
func defaultModeFor(agentType string, settings map[string]string) string {
	if m := savedDefaultMode(settings); m != "" {
		return m
	}
	return agent.DefaultLaunchPermissionMode(agentType)
}

// savedDefaultMode is the Operator's own saved default_permission_mode, "" when none is saved or it is not a mode. An unset default is not a saved one: the shipped default applies (#14336, Security's condition D).
func savedDefaultMode(settings map[string]string) string {
	m := setreg.Enum(settings, "default_permission_mode")
	if m != "" && agent.ValidPermissionMode(m) {
		return m
	}
	return ""
}

func unmarshalCaps(raw string, into *agent.Capabilities) error {
	return json.Unmarshal([]byte(raw), into)
}
