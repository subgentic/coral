package routes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/subgentic/coral/internal/custommodes"
	"github.com/subgentic/coral/internal/logsafe"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/agentmodels"
	at "github.com/subgentic/coral/internal/agenttypes"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/tracking"
)

// Launch creates a new agent session.
// POST /api/sessions/launch
func (h *SessionsHandler) Launch(w http.ResponseWriter, r *http.Request) {
	defer h.kickWS() // the feed shows the change now, not on the next tick
	var body struct {
		WorkingDir      string                 `json:"working_dir"`
		CreateDir       bool                   `json:"create_dir"`        // the folder is the suggested <home>/Coral/<name>: make it (#11258)
		CreateNewFolder bool                   `json:"create_new_folder"` // the folder is a new one the person chose inside an existing folder, and step 1 said Coral makes it (#12833)
		AgentType       string                 `json:"agent_type"`
		DisplayName     string                 `json:"display_name"`
		Flags           []string               `json:"flags"`
		Prompt          string                 `json:"prompt"`
		Skills          []string               `json:"skills"` // approved skills to tell the agent about (#12023): ids from the Skills Store
		BoardName       string                 `json:"board_name"`
		BoardID         string                 `json:"board_id"`  // join this board (#3536)
		NewBoard        bool                   `json:"new_board"` // create another board even if the name exists
		BoardServer     string                 `json:"board_server"`
		Backend         string                 `json:"backend"`
		BoardType       string                 `json:"board_type"`
		Model           string                 `json:"model"`
		Thinking        string                 `json:"thinking"` // the thinking level to start with ("" = the default for the type, else the CLI's own), #4969
		ResumeSessionID string                 `json:"resume_session_id"`
		Capabilities    *agent.Capabilities    `json:"capabilities"`
		Tools           []string               `json:"tools"`
		MCPServers      json.RawMessage        `json:"mcpServers"` // refused: not supported (#3644)
		Hooks           map[string]interface{} `json:"hooks"`
		// PermissionMode names Default and nothing else (#10362): the form sends no flag for Default, which is the same request as "nothing chosen", and nothing chosen starts in the saved default or Auto.
		PermissionMode string `json:"permission_mode"`
		// ConfirmHomeFolder: the person was asked about starting in the home folder itself and said Launch anyway (#13425).
		HomeFolderAsk     bool `json:"home_folder_ask"` // the page can answer the home-folder question (#13425); a page that cannot never gets it, so no launch is stopped for it
		ConfirmHomeFolder bool `json:"confirm_home_folder"`
		// KeepFullAccess: the form's "Use Full access for this agent" (#14085): the agent starts with Full access whatever its capabilities say, and keeps it on every restart. The Operator's alone.
		KeepFullAccess bool `json:"keep_full_access"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	// A custom permission mode (#15950) is the one other value: "custom:<id>", resolved to its flags when the launch is built. An agent never starts another agent in one (it may not start a less-restricted agent, #4032).
	_, customPick := custommodes.IDOf(body.PermissionMode)
	if customPick && agentCaller(r) {
		errBadRequest(w, "an agent cannot start another agent in a custom permission mode")
		return
	}
	if body.PermissionMode != "" && body.PermissionMode != "default" && !customPick {
		errBadRequest(w, `permission_mode can only be "default" or a custom mode's "custom:<id>"; any other mode is sent as the CLI's own flags`)
		return
	}
	if mcpGiven(body.MCPServers) {
		errBadRequest(w, errMCPNotSupported)
		return
	}
	// No agent_type (e.g. `coral-agent launch`) means the operator's default,
	// as the + New Agent modal pre-selects it.
	if body.AgentType == "" {
		if settings, err := h.ss.GetSettings(r.Context()); err == nil {
			body.AgentType = setreg.Enum(settings, setreg.DefaultAgentType)
		}
	}
	if body.ResumeSessionID != "" && !agent.IsResumeID(body.AgentType, body.ResumeSessionID) {
		errBadRequest(w, "resume_session_id is not a valid resume id") // #3582: it goes into file paths
		return
	}
	if body.ResumeSessionID != "" && body.AgentType == at.Hermes {
		errBadRequest(w, hermesResumeRefusal)
		return
	}
	if h.refuseAgentLaunchOverLimit(w, r, 1) {
		return
	}
	// Analytics: one requested/result pair per attempt, with controlled
	// categories only (never error text, paths, names or prompts).
	attempt := tracking.StartLaunch(tracking.KindAgent, tracking.ProviderFor(body.AgentType), h.launchBackendLabel(body.Backend), 1, body.ResumeSessionID != "")
	if body.WorkingDir == "" {
		attempt.Finish(tracking.OutcomeFailure, tracking.FailInvalidRequest, 0, 1)
		errBadRequest(w, "working_dir is required")
		return
	}
	// An agent that names no board starts the agent on its own team's board where that team's grant is on (#13903). Whatever it names, the launch is held to that team's caps and log below.
	if body.BoardName == "" && body.BoardID == "" && (body.BoardServer == "" || body.BoardServer == "local") {
		body.BoardID = h.callersBoardWithGrant(r)
	}
	// Which board on this Coral the agent joins or starts (#3536); a remote board's Coral decides its own.
	if (body.BoardName != "" || body.BoardID != "") && (body.BoardServer == "" || body.BoardServer == "local") {
		key, ok := h.launchBoard(w, r, body.BoardID, body.BoardName, body.NewBoard)
		if !ok {
			attempt.Finish(tracking.OutcomeFailure, tracking.FailInvalidRequest, 0, 1)
			return
		}
		body.BoardName = key
	}
	// An agent on a team whose grant is on starts agents in that team's folders, wherever the agent is placed (#13891, #13903).
	if h.refuseAgentLaunchOutsideTeam(w, r, body.WorkingDir) {
		attempt.Finish(tracking.OutcomeFailure, tracking.FailInvalidRequest, 0, 1)
		return
	}
	// An unknown agent_type used to fall through to Claude and return 200
	// ok:true, silently starting an agent the caller never asked for.
	if err := agent.ValidateAgentType(body.AgentType); err != nil {
		attempt.Finish(tracking.OutcomeFailure, tracking.FailInvalidRequest, 0, 1)
		errBadRequest(w, err.Error())
		return
	}
	// The gates below see what the launch will run: a custom mode's flags are added to the ones the form sent (launchSession adds them again from the stored mode, for the argv alone).
	gateFlags := body.Flags
	if customPick {
		if extra, _ := h.customModeFlags(r.Context(), body.AgentType, body.PermissionMode); extra != nil {
			gateFlags = append(append([]string{}, body.Flags...), extra...)
		}
	}
	// A launch from the dashboard's own dialog that would use the new default waits for the owner's acknowledgement of the notice first (#14353); nothing is started.
	if body.ResumeSessionID == "" && !body.KeepFullAccess && !customPick { // a custom mode is a mode the person named: no notice about the default
		settings, _ := h.ss.GetSettings(r.Context())
		if h.refuseUnseenDisclosure(w, r, launchDefaultSkips(body.AgentType, gateFlags, body.PermissionMode, settings)) {
			attempt.Finish(tracking.OutcomeFailure, tracking.FailInvalidRequest, 0, 1)
			return
		}
	}
	// Through the Coral Hub, an agent that skips permission prompts needs the owner's local switch (#126 F4).
	if refuseHubSkip(w, r, h.ss, hubAsksToSkip(body.AgentType, gateFlags, body.Capabilities, body.Tools, body.Hooks) || body.KeepFullAccess) { // Full access is the widest skip: through the Hub it meets the owner's switch like any other (#14193)
		attempt.Finish(tracking.OutcomeFailure, tracking.FailInvalidRequest, 0, 1)
		return
	}
	// A directory that does not exist is the caller's mistake: 400 naming the
	// field, so the dialog can mark it (it used to surface as a 500) (#3152).
	msg := createSuggestedDir(body.WorkingDir, body.CreateDir, h.cfg.CoralRoot)
	if msg == "" && body.CreateNewFolder && !body.CreateDir {
		if msg = newFolderCallerRefusal(r); msg == "" {
			msg, _ = createChosenFolder(body.WorkingDir)
		}
	}
	if msg == "" {
		msg = launchDirError(body.WorkingDir)
	}
	if msg != "" {
		attempt.Finish(tracking.OutcomeFailure, tracking.FailWorkdirUnavailable, 0, 1)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg, "field": "working_dir"})
		return
	}
	if askAboutHomeFolder(w, r, body.WorkingDir, body.HomeFolderAsk, body.ConfirmHomeFolder) {
		attempt.Finish(tracking.OutcomeFailure, tracking.FailHomeFolderAsked, 0, 1)
		return
	}
	slog.Info("launch request received",
		"working_dir", logsafe.Dir(body.WorkingDir),
		"agent_type", body.AgentType,
		"display_name", body.DisplayName,
		"requested_backend", body.Backend,
		"terminal_type", fmt.Sprintf("%T", h.terminal),
		"backend_type", fmt.Sprintf("%T", h.backend),
		"shell", filepath.Base(os.Getenv("SHELL")),
		"coral_tmux_bin_set", os.Getenv("CORAL_TMUX_BIN") != "",
	)

	// Validate resume support
	if body.ResumeSessionID != "" {
		agentImpl := agent.GetAgent(body.AgentType)
		if agentImpl != nil && !agentImpl.SupportsResume() {
			attempt.Finish(tracking.OutcomeFailure, tracking.FailUnsupportedOption, 0, 1)
			errBadRequest(w, fmt.Sprintf("Resume not supported for %s", body.AgentType))
			return
		}
	}

	// An agent never starts an agent that can do more without asking than itself (#4032, #5901, #7576, #11713, #7552), and the member that names nothing gets the new default CAPPED by the launching agent
	// (#14336, Security's ruling on #14333): one rule, capAgentLaunchFor, for every agent-made launch. The caller's authority is read from its stored row, never from the request. An explicit request above
	// it is refused with the reason; the Operator (the dashboard, the command line, the API key) keeps every choice.
	grantedMode := ""
	if body.KeepFullAccess && agentCaller(r) { // Keep Full access is never set by an agent: first, so the answer says so (#14336)
		if status, msg := h.keepFullAccessRequestRefusal(r, body.AgentType); status != 0 {
			attempt.Finish(tracking.OutcomeFailure, tracking.FailInvalidRequest, 0, 1)
			writeError(w, status, "", msg)
			return
		}
	}
	if agentCaller(r) {
		userSettings, serr := h.launchSettings(r.Context())
		if serr != nil {
			userSettings = nil // unreadable settings cap nothing less: the shipped default applies, and the cap still holds
		}
		grant, refusal := capAgentLaunchFor(h.callerAuthorityOf(r.Context(), r), agentLaunchAsk{
			AgentType: body.AgentType, Flags: body.Flags, PermissionMode: body.PermissionMode, Caps: body.Capabilities, Tools: body.Tools, Hooks: body.Hooks,
			OnBoard: body.BoardName != "" || body.BoardID != "", DefaultMode: defaultModeFor(body.AgentType, userSettings),
		})
		if refusal != nil {
			attempt.Finish(tracking.OutcomeFailure, tracking.FailInvalidRequest, 0, 1)
			writeError(w, http.StatusForbidden, refusal.Code, refusal.Message)
			return
		}
		body.Flags, body.Capabilities, body.Tools, body.Hooks = grant.Flags, grant.Caps, grant.Tools, grant.Hooks
		grantedMode = grant.Mode
	}

	if body.ResumeSessionID != "" && strings.TrimSpace(body.Model) == "" && strings.TrimSpace(body.Thinking) == "" { // a resume that names neither runs at what the conversation last ran at (#15293)
		body.Model, body.Thinking = h.resumedRunWith(body.AgentType, body.ResumeSessionID, body.WorkingDir)
	}
	// Resolve model: request wins, else per-type default from settings.
	takesSeat := h.launchTakesTheSeat(r.Context(), r, body.DisplayName, body.AgentType, body.BoardName, body.BoardServer)
	effectiveModel := h.resolveModelFor(r.Context(), body.AgentType, body.Model, takesSeat)
	if effectiveModel != "" && !agentmodels.ValidModelValue(effectiveModel) {
		attempt.Finish(tracking.OutcomeFailure, tracking.FailInvalidRequest, 0, 1)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": errInvalidModel, "field": "model"})
		return
	}

	// Thinking level: the request's, else the Settings default for the type.
	effectiveThinking, thinkingErr := h.resolveThinkingFor(r.Context(), body.AgentType, body.Thinking, takesSeat)
	if thinkingErr != "" {
		attempt.Finish(tracking.OutcomeFailure, tracking.FailInvalidRequest, 0, 1)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": thinkingErr, "field": "thinking"})
		return
	}

	// Add model flag if resolved to non-empty
	launchFlags := body.Flags
	if modelArgs, _ := agentmodels.ModelArgs(effectiveModel); modelArgs != nil { // checked above
		launchFlags = append(append([]string{}, body.Flags...), modelArgs...)
	}
	// Everything before this could be refused with nothing made; from here the terminal is made and the agent started whatever the request does (#5213).
	// An agent's launch onto a board is logged (the switch on or off) and, with the Operator's switch on, held to the board's caps (#11432).
	var lifeID int64
	acct := h.accountingBoard(r, body.BoardName, body.BoardServer) // the team the launch is held to, wherever the agent is placed (#13903)
	if agentCaller(r) && acct != "" {
		id, ok := h.beginAgentLaunch(w, r, acct, launchTargetName(body.DisplayName, body.AgentType))
		if !ok {
			attempt.Finish(tracking.OutcomeFailure, tracking.FailInvalidRequest, 0, 1)
			return
		}
		lifeID = id
	}
	skillRows, serr := h.resolveSkillIDs(r.Context(), body.Skills)
	if serr != nil {
		attempt.Finish(tracking.OutcomeFailure, tracking.FailInvalidRequest, 0, 1)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": serr.Error(), "field": "skills"})
		return
	}
	if body.KeepFullAccess {
		if status, msg := h.keepFullAccessRequestRefusal(r, body.AgentType); status != 0 {
			attempt.Finish(tracking.OutcomeFailure, tracking.FailInvalidRequest, 0, 1)
			writeError(w, status, "", msg)
			return
		}
	}
	lctx, cancel := lifecycleCtx(r.Context())
	defer cancel()
	result, err := h.launchSession(lctx, launchSpec{
		WorkDir: body.WorkingDir, AgentType: body.AgentType, DisplayName: body.DisplayName, ResumeSessionID: body.ResumeSessionID,
		Flags: launchFlags, Prompt: withSkillNote(body.Prompt, launchSkillNote(skillRows)), BoardName: body.BoardName, BoardServer: body.BoardServer, Backend: body.Backend,
		BoardType: body.BoardType, Model: effectiveModel, Thinking: effectiveThinking, Capabilities: body.Capabilities, Tools: body.Tools, Hooks: body.Hooks, PermissionMode: launchModeOf(agentCaller(r), grantedMode, body.PermissionMode, launchFlags),
		KeepFullAccess: body.KeepFullAccess,
		AutoByDefault:  !agentCaller(r) && autoDefaultAllowed(lctx, r, h.ss), // not for an agent's launch (it may not start a less-restricted agent, #4032), and a Hub request the owner does not let skip prompts asks instead (#5836)
	})
	if err != nil {
		h.endAgentLaunch(r.Context(), acct, lifeID, false, "", "")
		var refused *modelRefusedError
		if errors.As(err, &refused) { // a model Pi does not list: the request's fault, refused before anything was made (#11105)
			attempt.Finish(tracking.OutcomeFailure, tracking.FailInvalidRequest, 0, 1)
			writeModelRefused(w, refused)
			return
		}
		attempt.Finish(tracking.OutcomeFailure, classifyLaunchError(err), 0, 1)
		if refuse, ok := cliPathRefusal(viaHub(r.Context(), r), err); ok { // a setting to fix, not a server fault (#115)
			refuse(w)
			return
		}
		errInternalServer(w, err.Error())
		return
	}
	attempt.Finish(tracking.OutcomeSuccess, "", 1, 0)
	if body.KeepFullAccess {
		if sid, _ := result["session_id"].(string); sid != "" {
			h.storeKeepFullAccess(r.Context(), r, sid, launchTargetName(body.DisplayName, body.AgentType), "launch")
		}
	}
	h.endAgentLaunch(r.Context(), acct, lifeID, true, launcherWords(h.orchActorOf(r))+" started "+orchName(launchTargetName(body.DisplayName, body.AgentType)), fmt.Sprint(result["session_id"]))

	// Setup board subscription in background (prompt is passed as CLI arg, not via tmux send-keys)
	if body.BoardName != "" {
		h.setupBoardAndPrompt(result["session_id"].(string), result["session_name"].(string),
			body.AgentType, body.BoardName, launchedName(result, body.DisplayName))
	}

	if sid, _ := result["session_id"].(string); sid != "" { // pinned to the versions approved now; a newer one is an update to offer, never swapped in; using-coral is attached to every agent (#13523)
		if attach := h.withDefaultSkills(r.Context(), skillRows); len(attach) > 0 {
			if err := h.ss.AttachSkillsRetry(r.Context(), sid, attach); err != nil {
				slog.Warn("[launch] the skills attached to an agent were not saved", "session", sid, "error", err)
			}
		}
	}
	tracking.TrackEvent(tracking.EventSessionLaunched, nil)
	tracking.TrackOnce(tracking.EventFirstAgentLaunched, nil)
	if sid, _ := result["session_id"].(string); body.Prompt != "" && sid != "" && !agentCaller(r) { // the prompt a person wrote in the launch dialog is their first message (#10004)
		h.notePersonMessage(r.Context(), sid, tracking.MessageViaLaunchPrompt, time.Now())
	}
	if body.BoardName != "" && (body.BoardServer == "" || body.BoardServer == "local") {
		result["board_id"] = body.BoardName
		result["board_label"] = h.boardLabel(body.BoardName)
	}
	h.addLaunchNotice(r.Context(), result)
	writeJSON(w, http.StatusOK, result)
}

// errInvalidModel: a model goes to the CLI as --model's one argument, so it must be a model id
// (#4065, Security's condition 3).
const errInvalidModel = "model must be a model id: letters, digits and . _ : / @ [ ] + -, at most 128, not starting with -"

// errInvalidThinking says which levels a type takes.
func errInvalidThinking(agentType string) string {
	levels := agentmodels.ThinkingLevels(agentType)
	if len(levels) == 0 {
		return "a thinking level cannot be set for " + agentType + " agents yet"
	}
	return "thinking must be one of " + strings.Join(levels, ", ") + " for " + agentType + " agents (or empty for the default)"
}

// resolveThinking is a launch's thinking level: the request's, else the Settings default for the type (default_thinking_<type>).
// A request's level the type does not take is refused (the message is the reply's error); a saved default that no longer fits is
// ignored, as the CLI's own default then applies. Terminal agents have none.
func (h *SessionsHandler) resolveThinking(ctx context.Context, agentType, requested string) (level, refused string) {
	return h.resolveThinkingFor(ctx, agentType, requested, false)
}

// resolveThinkingFor is resolveThinking for a launch whose role is known (#13899): an Orchestrator falls back to default_orchestrator_thinking_<type> before the workers' default_thinking_<type>.
func (h *SessionsHandler) resolveThinkingFor(ctx context.Context, agentType, requested string, orchestrator bool) (level, refused string) {
	if agentType == "" {
		agentType = at.Claude
	}
	requested = strings.TrimSpace(requested)
	if requested != "" && !agentmodels.ValidThinking(agentType, requested) {
		return "", errInvalidThinking(agentType)
	}
	if requested != "" || agentType == at.Terminal {
		return requested, ""
	}
	settings, err := h.ss.GetSettings(ctx)
	if err != nil {
		return "", ""
	}
	return defaultThinkingForRole(settings, agentType, "", orchestrator), ""
}

// defaultThinkingFromSettings is requested, else the saved default_thinking_<type> when the type takes it.
func defaultThinkingFromSettings(settings map[string]string, agentType, requested string) string {
	return defaultThinkingForRole(settings, agentType, requested, false)
}

// defaultThinkingForRole is the level a launch starts on, first that is set and that the type takes winning: the one named in the launch, for an Orchestrator default_orchestrator_thinking_<type>, the
// type's default_thinking_<type>, none (#13899).
func defaultThinkingForRole(settings map[string]string, agentType, requested string, orchestrator bool) string {
	if requested = strings.TrimSpace(requested); requested != "" {
		if agentmodels.ValidThinking(agentType, requested) {
			return requested
		}
		return ""
	}
	if agentType == at.Terminal || settings == nil {
		return ""
	}
	if orchestrator {
		if d := setreg.TextFamily(settings, setreg.DefaultOrchestratorThinkingPrefix+agentType); d != "" && agentmodels.ValidThinking(agentType, d) {
			return d
		}
	}
	if d := setreg.TextFamily(settings, setreg.DefaultThinkingPrefix+agentType); agentmodels.ValidThinking(agentType, d) {
		return d
	}
	return ""
}

// explicitDefaultMode is "default" when the request asked for it and its flags carry no permission flag of their own (the person's flags win over every mode, as ever), else "" (the launch decides as before).
func explicitDefaultMode(requested string, flags []string) string {
	_, custom := custommodes.IDOf(requested) // a custom mode (#15950) is named the same way: "custom:<id>", resolved when the argv is built
	if requested != "default" && !custom {
		return ""
	}
	if own, _ := agent.SplitPermissionFlags(flags); len(own) > 0 {
		return ""
	}
	return requested
}

// launchModeOf is the mode a launch starts in explicitly: for an agent caller the one the cap granted (#14336), else the request's own explicit Default.
func launchModeOf(fromAgent bool, granted, requested string, flags []string) string {
	if fromAgent {
		return granted
	}
	return explicitDefaultMode(requested, flags)
}
