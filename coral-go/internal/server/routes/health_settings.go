package routes

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/httputil"
)

// healthSettingsPerHour is how many health setting changes one board takes an hour through this route (a loop that tunes every minute is not tuning).
const healthSettingsPerHour = 60

var healthSetLimit struct {
	sync.Mutex
	window time.Time
	counts map[string]int
}

func allowHealthSettingChange(project string, n int) bool {
	healthSetLimit.Lock()
	defer healthSetLimit.Unlock()
	now := time.Now().UTC().Truncate(time.Hour)
	if !healthSetLimit.window.Equal(now) || healthSetLimit.counts == nil || len(healthSetLimit.counts) > 1000 {
		healthSetLimit.window, healthSetLimit.counts = now, map[string]int{}
	}
	if healthSetLimit.counts[project]+n > healthSettingsPerHour {
		return false
	}
	healthSetLimit.counts[project] += n
	return true
}

// GetHealthSettings lists a board's health settings, each with its default and what it accepts (#20136): GET /api/board/{project}/health/settings. The team's Orchestrator or the Operator, locally.
func (h *BoardHandler) GetHealthSettings(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	if _, ok := h.healthAdmin(r, project); !ok {
		errForbidden(w, "only the team's orchestrator or the Operator can read the health settings this way")
		return
	}
	hs := h.bs.GetHealthSettings(r.Context(), project)
	out := map[string]any{"keys": board.HealthKeys(hs)}
	if v := r.URL.Query().Get("since"); v != "" { // the changes made through this route in a time (a digest counts them): ?since=24h
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 || d > 30*24*time.Hour {
			errBadRequest(w, "since: a duration such as 24h, at most 720h")
			return
		}
		log, err := h.bs.HealthSettingsLog(r.Context(), project, time.Now().Add(-d))
		if err != nil {
			errInternalServer(w, err.Error())
			return
		}
		out["log"] = log
	}
	writeJSON(w, http.StatusOK, out)
}

// PutHealthSettings changes health settings: PUT /api/board/{project}/health/settings {"health": {<the settings to change, nested as HealthSettings is>}} (#20136, the Operator: the Orchestrator tunes every health
// setting, no grant needed). It is the same save as the team's Settings form: the same checks (checkHealthPatch), the same store write (UpdateBoardSettings), and a number outside its range is refused with what is accepted.
// The team's Orchestrator or the Operator, locally; never through Coral Hub; only the health settings of this board.
func (h *BoardHandler) PutHealthSettings(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	if h.bs.StaysDeleted(r.Context(), project) {
		writeError(w, http.StatusNotFound, "board_deleted", "this board was deleted")
		return
	}
	who, ok := h.healthAdmin(r, project)
	if !ok {
		errForbidden(w, "only the team's orchestrator or the Operator can change the health settings")
		return
	}
	var body struct {
		Health json.RawMessage `json:"health"`
		// Key and Value (or Reset) set one setting by its dotted key, the way `coral-board health settings set|reset` does: the patch is made here, so the command line carries no copy of the key list.
		Key   string `json:"key"`
		Value string `json:"value"`
		Reset bool   `json:"reset"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, `invalid JSON: {"health": {...}} or {"key": "...", "value": "..."}`)
		return
	}
	if body.Key != "" {
		value := body.Value
		if body.Reset {
			for _, k := range board.HealthKeys(board.DefaultHealthSettings()) {
				if k.Key == body.Key {
					value = fmt.Sprint(k.Default)
				}
			}
		}
		patch, err := board.HealthPatchFor(body.Key, value)
		if err != nil {
			errBadRequest(w, err.Error())
			return
		}
		body.Health, _ = json.Marshal(patch)
	}
	if len(body.Health) == 0 || string(body.Health) == "null" {
		errBadRequest(w, `invalid JSON: {"health": {...}} or {"key": "...", "value": "..."}`)
		return
	}
	// Strict: only settings Coral knows (a typo is an error, not a no-op).
	var strict board.HealthSettings
	dec := json.NewDecoder(strings.NewReader(string(body.Health)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&strict); err != nil {
		errBadRequest(w, "health: "+err.Error()+"; `coral-board health settings show` lists the settings")
		return
	}
	before := h.bs.GetHealthSettings(r.Context(), project)
	merged, ok := h.checkHealthPatch(w, r, project, body.Health, false)
	if !ok {
		return
	}
	if msg := board.HealthOutOfRange(merged, board.HealthPatchKeys(body.Health)); msg != "" {
		errBadRequest(w, "health."+msg)
		return
	}
	changes := board.HealthChanges(before, merged.Clamp())
	if len(changes) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "changed": []board.HealthChange{}})
		return
	}
	if !allowHealthSettingChange(project, len(changes)) {
		httputil.WriteActionLimit(w, 0, "health_settings_rate_limited", fmt.Sprintf("too many health setting changes for this team in the last hour (at most %d); try again later", healthSettingsPerHour))
		return
	}
	if _, err := h.bs.UpdateBoardSettings(r.Context(), project, board.BoardSettingsUpdate{Health: &merged, HealthPatch: body.Health}); err != nil {
		errInternalServer(w, err.Error())
		return
	}
	for _, c := range changes { // the board's settings log: the key and the old and new value, "changed" for text a person typed
		if err := h.bs.AppendEditLog(r.Context(), project, who, "health."+c.Key, c.Old, c.New); err != nil {
			slog.Warn("health settings: could not log a change", "board", project, "key", c.Key, "error", err)
		}
	}
	// Told to the Orchestrator and the team like every settings change (#13173): the same notice the form's save sends.
	noteSettingsChange(h.bs, r, project, map[string]any{"health": before}, map[string]any{"health": merged.Clamp()})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "changed": changes})
}
