package routes

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/subgentic/coral/internal/agent"
)

// The first-launch disclosure (#14353, Security's MUST 3 on #14333): agents start with full permissions, and the person is told once, in words the server owns, before a launch from the dashboard's own
// dialog uses that default. The text and its id live here; the acknowledgement is an operator-only record of the id and when (never a browser flag, never set by an agent route or by any launch).
const (
	// LaunchDisclosureID versions the words: a change of the text is a new id, and an old acknowledgement then no longer counts.
	LaunchDisclosureID = "full-permissions-3"
	// LaunchDisclosureText is the measured behaviour in plain words (Auto still judges a force push or a delete outside the project; Codex stays in its sandbox).
	LaunchDisclosureText = "Agents you start here begin with full permissions. They run as you, with every file you can reach: they can read and change files, run commands and use the web without asking you first. " +
		"Claude's own safety checks still apply to destructive commands such as a force push or a delete outside the project, and Codex stays inside its project folder. " +
		"Hermes, OpenCode and Pi agents run with no such checks at all, and so does any agent you start in Bypass or with Full access (Codex then leaves its folder too). " +
		"To start one with fewer permissions, pick a lower permission mode when you launch it, or set a default permission mode in Settings."
	// PermissionLoweringText is where to lower it, carried in every launch answer.
	PermissionLoweringText = "To lower it: pass a lower permission mode when you launch (a CLI permission flag, or permission_mode default), or set a default permission mode in Settings."
	// launchDisclosureAckSetting holds {"id","at"}. It is hidden from GET /api/settings and cannot be written through PUT /api/settings (the registry does not know it).
	launchDisclosureAckSetting = "launch_disclosure_ack"
	launchDisclosureRequired   = "launch_disclosure_required"
)

type launchDisclosureView struct {
	ID   string `json:"id"`
	Text string `json:"text"`
	Seen bool   `json:"seen"`
	At   string `json:"acknowledged_at,omitempty"`
}

// launchDisclosureState reads the stored acknowledgement: seen only for the current id. An unreadable or foreign record is "not seen" (the person is told again, never skipped).
func launchDisclosureState(settings map[string]string) launchDisclosureView {
	v := launchDisclosureView{ID: LaunchDisclosureID, Text: LaunchDisclosureText}
	var ack struct {
		ID string `json:"id"`
		At string `json:"at"`
	}
	if raw := settings[launchDisclosureAckSetting]; raw != "" && json.Unmarshal([]byte(raw), &ack) == nil && ack.ID == LaunchDisclosureID {
		v.Seen, v.At = true, ack.At
	}
	return v
}

// launchDisclosureRefusal answers a request that may not read or change the acknowledgement: an agent's token, or a Coral Hub sign-in that is not the account this computer is linked to.
func launchDisclosureRefusal(w http.ResponseWriter, r *http.Request) bool {
	if agentCaller(r) {
		writeError(w, http.StatusForbidden, "forbidden_for_agent", "Only the Operator can read or answer the first-launch notice.")
		return true
	}
	return refuseNonOwner(w, r)
}

// GetLaunchDisclosure is GET /api/launch-disclosure: the text, its id and whether this install's owner has acknowledged it.
func (h *SessionsHandler) GetLaunchDisclosure(w http.ResponseWriter, r *http.Request) {
	if launchDisclosureRefusal(w, r) {
		return
	}
	settings, err := h.ss.GetSettings(r.Context())
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, launchDisclosureState(settings))
}

// AckLaunchDisclosure is POST /api/launch-disclosure/ack {"id"}: the owner has read the current text. A stale id is refused (the words changed). It records only the id and the time.
func (h *SessionsHandler) AckLaunchDisclosure(w http.ResponseWriter, r *http.Request) {
	if launchDisclosureRefusal(w, r) {
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := decodeJSON(r, &body); err != nil || body.ID != LaunchDisclosureID {
		writeError(w, http.StatusBadRequest, "stale_disclosure", "That notice has changed: read the current one.")
		return
	}
	rec, _ := json.Marshal(map[string]string{"id": LaunchDisclosureID, "at": time.Now().UTC().Format(time.RFC3339)})
	if err := h.ss.SetSetting(r.Context(), launchDisclosureAckSetting, string(rec)); err != nil {
		errInternalServer(w, err.Error())
		return
	}
	slog.Info("[launch-disclosure] acknowledged", "id", LaunchDisclosureID)
	settings, err := h.ss.GetSettings(r.Context())
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, launchDisclosureState(settings))
}

// ClearLaunchDisclosure is DELETE /api/launch-disclosure/ack: only the owner can take the acknowledgement back, and the notice is shown again.
func (h *SessionsHandler) ClearLaunchDisclosure(w http.ResponseWriter, r *http.Request) {
	if launchDisclosureRefusal(w, r) {
		return
	}
	if _, err := h.ss.DeleteSetting(r.Context(), launchDisclosureAckSetting); err != nil {
		errInternalServer(w, err.Error())
		return
	}
	slog.Info("[launch-disclosure] cleared")
	writeJSON(w, http.StatusOK, launchDisclosureView{ID: LaunchDisclosureID, Text: LaunchDisclosureText})
}

// dialogLaunch is a launch from the dashboard's own dialog: a person at this computer's dashboard (its session cookie), not an API key, the command line, an agent's token, a job or Coral Hub.
// Only such a launch waits for the acknowledgement; every other path answers with the mode used instead and never blocks (Orchestrator and Security, 20:39).
func dialogLaunch(r *http.Request) bool {
	if agentCaller(r) {
		return false
	}
	kind, _ := r.Context().Value(callerKindKey{}).(string)
	return kind == callerDashCookie
}

// launchDefaultSkips is whether a dialog launch starts in a mode that skips the prompts that the notice is about: the shipped default of its type, or the same mode written out as the CLI's own flags
// (the dashboard's forms send their shipped Auto that way, so the flags cannot be a way round the notice). An explicit Default, a saved default (the owner's own choice) and a mode that asks do not
// count. The server enforces it; the page is not the only gate.
func launchDefaultSkips(agentType string, flags []string, permissionMode string, settings map[string]string) bool {
	if permissionMode == "default" || savedDefaultMode(settings) != "" { // only "default" names a mode: the launch honours no other value, so another one is as good as none
		return false
	}
	return effectiveLaunchSkips(agentType, flags)
}

// effectiveLaunchSkips is whether a launch of the type with these flags (the CLI's own permission flags among them) starts without asking: the flags' mode when they carry one, else the
// shipped default of the type.
func effectiveLaunchSkips(agentType string, flags []string) bool {
	if carried, _ := agent.SplitPermissionFlags(flags); len(carried) > 0 || agent.PermissionModeFromFlags(flags) != "" {
		return agent.SkipsPermissionPrompts(agentType, flags)
	}
	mode := agent.DefaultLaunchPermissionMode(agentType)
	return mode == "auto" || mode == "bypassPermissions"
}

// refuseUnseenDisclosure answers a dialog launch that would use the new default before the owner has acknowledged the notice: 409 launch_disclosure_required with the notice, and nothing started.
// A launch from any other path, one that names its mode, and one after the acknowledgement go on. It reports whether it answered.
func (h *SessionsHandler) refuseUnseenDisclosure(w http.ResponseWriter, r *http.Request, usesDefault bool) bool {
	if !usesDefault || !dialogLaunch(r) {
		return false
	}
	settings, err := h.ss.GetSettings(r.Context())
	if err != nil {
		return false // an unreadable record never blocks a launch
	}
	v := launchDisclosureState(settings)
	if v.Seen {
		return false
	}
	writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "code": launchDisclosureRequired, "error": "Read the first-launch notice, then launch again.", "disclosure": v})
	return true
}

// addLaunchNotice puts the lowering sentence in a launch answer and, while the notice is unseen, the notice itself (the paths that never block carry it here).
func (h *SessionsHandler) addLaunchNotice(ctx context.Context, answer map[string]any) {
	answer["permission_lowering"] = PermissionLoweringText
	if settings, err := h.ss.GetSettings(ctx); err == nil {
		if v := launchDisclosureState(settings); !v.Seen {
			answer["launch_disclosure"] = map[string]string{"id": v.ID, "text": v.Text}
		}
	}
}

