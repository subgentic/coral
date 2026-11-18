package routes

import (
	"bytes"
	"encoding/json"
	"net/http"
	"regexp"

	"github.com/subgentic/coral/internal/cloud"
)

// The Automations reads through Coral Hub (#19570, coral-hub's design §7.3.3 and Security's C5): a request that arrived over the Hub's tunnel (cloud.Tunneled, the owner's too) gets only the fields of coral-hub's
// accepted list; every other field, one added later included, is left out here, so the prompts, commands, folders, results and logs of a job or workflow never cross the Hub. A request made on this computer keeps
// every field. This is an allow-list applied to the decoded reply: it names what stays, and what it does not name is gone.

// hubWord is the shape of a fixed word the Hub page may show (an error code): anything else is "".
var hubWord = regexp.MustCompile(`^[a-z_]{1,40}$`)

// keepAs says how one kept field is copied.
type keepAs func(v any) any

func same(v any) any { return v }

func errWord(v any) any {
	if s, ok := v.(string); ok && hubWord.MatchString(s) {
		return s
	}
	return ""
}

// project copies the fields a spec keeps from a decoded JSON object. A field that is absent stays absent.
func project(m map[string]any, spec map[string]keepAs) map[string]any {
	out := make(map[string]any, len(spec))
	for k, how := range spec {
		if v, ok := m[k]; ok {
			out[k] = how(v)
		}
	}
	return out
}

func each(spec func(map[string]any) map[string]any) keepAs {
	return func(v any) any {
		list, ok := v.([]any)
		if !ok {
			return []any{}
		}
		out := make([]any, 0, len(list))
		for _, e := range list {
			if m, ok := e.(map[string]any); ok {
				out = append(out, spec(m))
			}
		}
		return out
	}
}

func object(spec func(map[string]any) map[string]any) keepAs {
	return func(v any) any {
		if m, ok := v.(map[string]any); ok {
			return spec(m)
		}
		return nil
	}
}

// failedStepNumber keeps the number of the step a run failed at, never its name.
func failedStepNumber(m map[string]any) map[string]any {
	return project(m, map[string]keepAs{"number": same})
}

var runFields = map[string]keepAs{
	"kind": same, "id": same, "job_name": same, "display_name": same, "workflow_name": same, "status": same, "trigger_type": same,
	"scheduled_at": same, "started_at": same, "finished_at": same, "duration_seconds": same, "error_code": errWord,
	"failed_step": object(failedStepNumber),
}

func hubRun(m map[string]any) map[string]any { return project(m, runFields) }

// hubJobLastRun and hubWorkflowLastRun are the few fields of a last run the lists carry.
func hubJobLastRun(m map[string]any) map[string]any {
	return project(m, map[string]keepAs{"status": same, "started_at": same, "finished_at": same, "error_code": errWord})
}

func hubWorkflowLastRun(m map[string]any) map[string]any {
	return project(m, map[string]keepAs{"status": same, "trigger_type": same, "started_at": same, "finished_at": same, "failed_step": object(failedStepNumber)})
}

func hubJob(m map[string]any) map[string]any {
	out := project(m, map[string]keepAs{
		"id": same, "name": same, "enabled": same, "cron_expr": same, "timezone": same, "next_fire_at": same, "consecutive_failures": same,
		"last_run": object(hubJobLastRun),
	})
	if v, ok := m["paused_reason"]; ok { // whether the job is paused, never why (the text is free)
		s, _ := v.(string)
		out["paused"] = s != ""
	}
	return out
}

func hubWorkflow(m map[string]any) map[string]any {
	out := project(m, map[string]keepAs{"id": same, "name": same, "enabled": same, "step_count": same, "last_run": object(hubWorkflowLastRun)})
	if _, ok := out["step_count"]; !ok { // a workflow read on its own lists its steps: the Hub gets how many, never what they say
		if steps, ok := m["steps"].([]any); ok {
			out["step_count"] = len(steps)
		}
	}
	return out
}

// hubShape is what one route's reply keeps: an envelope of lists and counts, or one object.
type hubShape func(map[string]any) map[string]any

var (
	hubJobsList hubShape = func(m map[string]any) map[string]any { return project(m, map[string]keepAs{"jobs": each(hubJob)}) }
	hubJobOne   hubShape = hubJob
	hubRunsList hubShape = func(m map[string]any) map[string]any {
		return project(m, map[string]keepAs{"runs": each(hubRun), "total": same, "has_more": same})
	}
	hubWfList hubShape = func(m map[string]any) map[string]any {
		return project(m, map[string]keepAs{"workflows": each(hubWorkflow)})
	}
	hubWfOne  hubShape = hubWorkflow
	hubRunOne hubShape = hubRun
)

// hubErrorBody is an error reply through the tunnel: its status, a fixed sentence for that status and, when the reply had one, its code if it is a plain word. The handlers' own text is never passed on:
// several of these reads send err.Error() (a database or path message) or echo a name from the request (#19583).
func hubErrorBody(status int, m map[string]any) map[string]any {
	text := "Something went wrong reading this through Coral Hub"
	switch {
	case status == http.StatusNotFound:
		text = "Not found"
	case status >= 400 && status < 500:
		text = "The request was not accepted"
	}
	out := map[string]any{"error": text}
	if c, ok := m["code"].(string); ok && hubWord.MatchString(c) {
		out["code"] = c
	}
	return out
}

// holdingWriter keeps a handler's reply so it can be cut before it is sent.
type holdingWriter struct {
	h    http.Header
	code int
	buf  bytes.Buffer
}

func (w *holdingWriter) Header() http.Header { return w.h }
func (w *holdingWriter) WriteHeader(c int) {
	if w.code == 0 {
		w.code = c
	}
}
func (w *holdingWriter) Write(b []byte) (int, error) {
	if w.code == 0 {
		w.code = http.StatusOK
	}
	return w.buf.Write(b)
}

// HubFields cuts the reply of an Automations read to the allow-list when the request came through Coral Hub's tunnel; on this computer it is the handler itself. A reply that is not the JSON the shape expects is
// not passed on: nothing unlisted crosses because it could not be read.
func HubFields(shape hubShape) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !cloud.Tunneled(r) {
				next.ServeHTTP(w, r)
				return
			}
			if refuseNonOwner(w, r) { // the table's OwnerRefuse rows: a grantee or another owner never reaches the read
				return
			}
			hw := &holdingWriter{h: http.Header{}}
			next.ServeHTTP(hw, r)
			if hw.code == 0 {
				hw.code = http.StatusOK
			}
			var decoded map[string]any
			if err := json.Unmarshal(hw.buf.Bytes(), &decoded); err != nil {
				errInternalServer(w, "Not shown through Coral Hub")
				return
			}
			var out map[string]any
			if hw.code >= 300 {
				out = hubErrorBody(hw.code, decoded)
			} else {
				out = shape(decoded)
			}
			w.Header().Set("Content-Type", "application/json")
			if v := hw.h.Get("Cache-Control"); v != "" {
				w.Header().Set("Cache-Control", v)
			}
			w.WriteHeader(hw.code)
			_ = json.NewEncoder(w).Encode(out)
		})
	}
}

// The cut of each Automations read, one per reply shape (#19570). router.go registers each read with its own: r.With(routes.HubRuns).Get(...).
var (
	HubJobs      = HubFields(hubJobsList)
	HubJob       = HubFields(hubJobOne)
	HubRuns      = HubFields(hubRunsList)
	HubWorkflows = HubFields(hubWfList)
	HubWorkflow  = HubFields(hubWfOne)
	HubRun       = HubFields(hubRunOne)
)
