package routes

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/robfig/cron/v3"

	"github.com/subgentic/coral/internal/background"
	"github.com/subgentic/coral/internal/store"
)

// The routes of a team's daily knowledge (#13928), under /api/teams/detail/{name}/daily-knowledge (a path of its own: it cannot be taken for an agent named "daily" on the knowledge routes):
//
//	GET  .../daily-knowledge                the switch, the last run, the next one and the waiting candidate with a diff against the live files
//	PUT  .../daily-knowledge                {enabled: bool}: the team's switch. The server builds the job (kind knowledge, this team, the default schedule); nothing else comes from the body
//	PUT  .../daily-knowledge/auto-apply     {enabled: bool}: whether a daily update is applied by itself (off by default)
//	POST .../daily-knowledge/accept         the waiting candidate becomes the live knowledge (the replaced files are kept for one revert)
//	POST .../daily-knowledge/revert         the last accepted update is taken back
//
// The writes are the owner's alone through the Hub and a person's alone locally; an agent's token is refused (they change what every agent of the team is told at its start).

var knowledgeSwitchMu sync.Mutex // the switch route and the job's own toggle read and write the one enabled flag under this

type dailyFileDiff struct {
	File      string `json:"file"`
	Diff      string `json:"diff,omitempty"`
	TooBig    bool   `json:"too_big,omitempty"`
	Unchanged bool   `json:"unchanged,omitempty"`
	NewChars  int    `json:"new_chars"`
	IsNew     bool   `json:"is_new,omitempty"` // no live file yet
}

func (h *SessionsHandler) knowledgePerson(w http.ResponseWriter, r *http.Request) (team string, ok bool) {
	if refuseNonOwner(w, r) {
		return "", false
	}
	if !humanInputCaller(r) {
		writeError(w, http.StatusForbidden, "operator_only", "only the person at this computer can change what a team's knowledge says or whether it is distilled daily")
		return "", false
	}
	team = chi.URLParam(r, "name")
	if !background.ValidKnowledgeTeam(team) {
		errBadRequest(w, "invalid team name")
		return "", false
	}
	return team, true
}

func (h *SessionsHandler) knowledgeJobOf(ctx context.Context, team string) *store.ScheduledJob {
	jobs, err := store.NewScheduleStore(h.db).ListScheduledJobs(ctx, false)
	if err != nil {
		return nil
	}
	for i := range jobs {
		if jobs[i].JobType == "knowledge" && jobs[i].TeamName == team {
			return &jobs[i]
		}
	}
	return nil
}

// DailyKnowledgeStatus answers GET .../daily-knowledge.
func (h *SessionsHandler) DailyKnowledgeStatus(w http.ResponseWriter, r *http.Request) {
	team := chi.URLParam(r, "name")
	if !background.ValidKnowledgeTeam(team) {
		errBadRequest(w, "invalid team name")
		return
	}
	ctx := r.Context()
	out := map[string]any{"team": team, "enabled": false, "job": false, "auto_apply": background.AutoApplyOn(h.cfg.CoralDir(), team)}
	if job := h.knowledgeJobOf(ctx, team); job != nil {
		out["job"], out["job_id"], out["enabled"] = true, job.ID, job.Enabled == 1
		out["cron_expr"], out["timezone"] = job.CronExpr, job.Timezone
		if job.PausedReason != "" {
			out["paused_reason"] = job.PausedReason
		}
		if run, err := store.NewScheduleStore(h.db).GetLastRunForJob(ctx, job.ID); err == nil && run != nil {
			last := map[string]any{"status": run.Status, "started_at": run.StartedAt, "finished_at": run.FinishedAt, "trigger": run.TriggerType}
			if run.ExitReason != nil {
				last["reason"] = *run.ExitReason
			}
			if run.ErrorCode != nil {
				last["code"] = *run.ErrorCode
			}
			out["last_run"] = last
		}
		if sch, err := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow).Parse(job.CronExpr); err == nil {
			loc := time.UTC
			if l, err := time.LoadLocation(job.Timezone); err == nil {
				loc = l
			}
			out["next_run_at"] = sch.Next(time.Now().In(loc)).UTC().Format(time.RFC3339)
		}
	}
	if id := background.PreviousID(h.cfg.CoralDir(), team); id != "" {
		out["previous"] = map[string]any{"id": id} // what a revert would put back
	}
	st := background.ReadAutoState(h.cfg.CoralDir(), team)
	if st.LastRunAt != "" {
		out["last_distilled_at"], out["approx_tokens"], out["calls"] = st.LastRunAt, st.ApproxTokens, st.Calls
	}
	if cand, err := background.ReadCandidate(h.cfg.CoralDir(), team); err == nil && cand != nil {
		names := make([]string, 0, len(cand.Files))
		for n := range cand.Files {
			names = append(names, n)
		}
		sort.Strings(names)
		files := make([]dailyFileDiff, 0, len(names))
		for _, n := range names {
			f := cand.Files[n]
			d := dailyFileDiff{File: n, NewChars: len(f.New), IsNew: f.Live == ""}
			hunks, ok := unifiedHunks(f.Live, f.New)
			switch {
			case !ok:
				d.TooBig = true
			case hunks == "":
				d.Unchanged = true
			default:
				d.Diff = hunks
			}
			files = append(files, d)
		}
		out["candidate"] = map[string]any{"id": background.CandidateID(h.cfg.CoralDir(), team), "created_at": cand.Meta.CreatedAt, "held": cand.Meta.Held, "held_reason": cand.Meta.HeldReason, "approx_tokens": cand.Meta.ApproxTokens, "files": files}
	}
	writeJSON(w, http.StatusOK, out)
}

type enabledBody struct {
	Enabled *bool `json:"enabled"`
}

// strictEnabled reads the body {enabled: bool} and nothing else.
func strictEnabled(w http.ResponseWriter, r *http.Request) (bool, bool) {
	var b enabledBody
	if err := decodeJSONStrict(r, &b); err != nil || b.Enabled == nil {
		errBadRequest(w, `the body is {"enabled": true} or {"enabled": false} and nothing else`)
		return false, false
	}
	return *b.Enabled, true
}

// SetDailyKnowledge answers PUT .../daily-knowledge: the team's switch. On makes the team's job (or switches it on); off switches it off. A job the scheduler paused stays paused (409): a good run resumes it.
func (h *SessionsHandler) SetDailyKnowledge(w http.ResponseWriter, r *http.Request) {
	team, ok := h.knowledgePerson(w, r)
	if !ok {
		return
	}
	on, ok := strictEnabled(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	if !h.TeamHasKnowledgeToDistill(ctx, team) {
		errNotFound(w, "no such team on this computer")
		return
	}
	knowledgeSwitchMu.Lock()
	defer knowledgeSwitchMu.Unlock()
	ss := store.NewScheduleStore(h.db)
	job := h.knowledgeJobOf(ctx, team)
	switch {
	case job == nil && !on:
		// nothing to switch off
	case job == nil:
		nj := background.NewKnowledgeJob(team)
		if _, err := ss.CreateScheduledJob(ctx, &nj); err != nil {
			errInternalServer(w, "could not make the job")
			return
		}
	case on && job.Enabled == 0 && job.PausedReason != "":
		writePausedKnowledge(w)
		return
	default:
		want := 0
		if on {
			want = 1
		}
		if job.Enabled != want {
			if _, err := ss.UpdateScheduledJob(ctx, job.ID, map[string]interface{}{"enabled": want}); err != nil {
				errInternalServer(w, "could not change the job")
				return
			}
		}
	}
	h.DailyKnowledgeStatus(w, r)
}

// SetDailyKnowledgeAutoApply answers PUT .../daily-knowledge/auto-apply.
func (h *SessionsHandler) SetDailyKnowledgeAutoApply(w http.ResponseWriter, r *http.Request) {
	team, ok := h.knowledgePerson(w, r)
	if !ok {
		return
	}
	on, ok := strictEnabled(w, r)
	if !ok {
		return
	}
	if err := background.SetAutoApply(h.cfg.CoralDir(), team, on); err != nil {
		errInternalServer(w, "could not save the switch")
		return
	}
	h.DailyKnowledgeStatus(w, r)
}

// AcceptDailyKnowledge answers POST .../daily-knowledge/accept {candidate: id, confirm_held?: bool}: the candidate the person was shown becomes the live knowledge (that is the person's decision). A candidate
// a newer run has replaced since is 409 candidate_changed and nothing is written; a held one needs confirm_held.
func (h *SessionsHandler) AcceptDailyKnowledge(w http.ResponseWriter, r *http.Request) {
	team, ok := h.knowledgePerson(w, r)
	if !ok {
		return
	}
	var b struct {
		Candidate   string `json:"candidate"`
		ConfirmHeld bool   `json:"confirm_held"`
	}
	if err := decodeJSONStrict(r, &b); err != nil || b.Candidate == "" {
		errBadRequest(w, `the body is {"candidate": "<the id the status gave>"} and, for a held candidate, "confirm_held": true`)
		return
	}
	switch err := background.AcceptShownCandidate(h.cfg.CoralDir(), team, b.Candidate, b.ConfirmHeld); {
	case err == nil:
	case errors.Is(err, background.ErrNoCandidate):
		writeError(w, http.StatusConflict, "no_candidate", "there is no candidate waiting for this team")
		return
	case errors.Is(err, background.ErrCandidateChanged):
		writeError(w, http.StatusConflict, "candidate_changed", "a newer run replaced the candidate you were shown: look at the new one")
		return
	case errors.Is(err, background.ErrHeldNeedsConfirm):
		writeError(w, http.StatusConflict, "held_needs_confirm", "this candidate is held for a person to look at: read why, and accept it with confirm_held")
		return
	default:
		errInternalServer(w, "could not apply the candidate")
		return
	}
	h.DailyKnowledgeStatus(w, r)
}

// RevertDailyKnowledge answers POST .../daily-knowledge/revert {previous: id}: the update the person was shown is taken back; another update accepted since is 409 candidate_changed.
func (h *SessionsHandler) RevertDailyKnowledge(w http.ResponseWriter, r *http.Request) {
	team, ok := h.knowledgePerson(w, r)
	if !ok {
		return
	}
	var b struct {
		Previous string `json:"previous"`
	}
	if err := decodeJSONStrict(r, &b); err != nil || b.Previous == "" {
		errBadRequest(w, `the body is {"previous": "<the id the status gave>"}`)
		return
	}
	switch err := background.RevertShownUpdate(h.cfg.CoralDir(), team, b.Previous); {
	case err == nil:
	case errors.Is(err, background.ErrNothingToRevert):
		writeError(w, http.StatusConflict, "nothing_to_revert", "there is no earlier version of this team's knowledge to go back to")
		return
	case errors.Is(err, background.ErrCandidateChanged):
		writeError(w, http.StatusConflict, "candidate_changed", "another update was accepted since you looked: look at the current state")
		return
	default:
		errInternalServer(w, "could not take the update back")
		return
	}
	h.DailyKnowledgeStatus(w, r)
}
