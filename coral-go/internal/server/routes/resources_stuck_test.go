package routes

import (
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/resources"
)

// #13705: the list names a holder the watcher has told the Orchestrator of, so the Queue folder can say Stuck (and for how long); nobody else carries the field.
func TestTheListMarksAStuckHolder(t *testing.T) {
	g := newResRig(t)
	g.subscribe("alpha", "Dev A", "Developer", false)
	g.subscribe("alpha", "Dev B", "Developer", false)
	var said []string
	skew := time.Duration(0)
	now := func() time.Time { return time.Now().Add(skew) }
	began := time.Now() // the prompt opened when the test began
	w := resources.NewWatcher(g.mgr, resources.WatchOptions{Now: now,
		Signal: func(agent string) (string, time.Time) {
			if agent == "Dev A" {
				return resources.SignalPrompt, began
			}
			return "", time.Time{}
		},
		Notify: func(agent, text string) { said = append(said, agent+": "+text) }})
	h := &ResourcesHandler{M: g.mgr, Board: g.bs, Watch: w}
	r := chi.NewRouter()
	r.Get("/api/resources", h.List)
	r.Get("/api/resources/{name}", h.Get)
	r.Post("/api/resources/{name}/claim", h.Claim)
	r.Put("/api/resources/{name}", h.Define)
	g.r = r
	g.do("operator", "PUT", "/api/resources/mac-heavy", map[string]any{"slots": 1})
	g.do("token:Dev A", "POST", "/api/resources/mac-heavy/claim", map[string]any{})
	g.do("token:Dev B", "POST", "/api/resources/mac-heavy/claim", map[string]any{})
	w.Check()
	_, list := g.do("operator", "GET", "/api/resources", nil)
	holder := list["resources"].([]any)[0].(map[string]any)["holders"].([]any)[0].(map[string]any)
	assert.NotContains(t, holder, "stuck", "not yet")
	skew = 6 * time.Minute
	w.Check()
	_, list = g.do("operator", "GET", "/api/resources", nil)
	assert.Equal(t, "prompt", list["resources"].([]any)[0].(map[string]any)["holders"].([]any)[0].(map[string]any)["stuck"], "marked from the first notice")
	skew = 11 * time.Minute
	w.Check()
	_, list = g.do("operator", "GET", "/api/resources", nil)
	res := list["resources"].([]any)[0].(map[string]any)
	holder = res["holders"].([]any)[0].(map[string]any)
	assert.Equal(t, "prompt", holder["stuck"])
	assert.EqualValues(t, 11, holder["stuck_min"], "eleven minutes after the claim")
	assert.NotContains(t, res["queue"].([]any)[0].(map[string]any), "stuck", "a waiting entry is never stuck")
	require.Len(t, said, 2, "told at five minutes' worth and again at ten")
	_, one := g.do("operator", "GET", "/api/resources/mac-heavy", nil)
	assert.Equal(t, "prompt", one["holders"].([]any)[0].(map[string]any)["stuck"], "a single resource says it too")
}
