package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #14774 (#14728 part (a); Security's conditions, #194701): Codex's 'Approaching rate limits' notice is answered whole from a row, found by its STRUCTURE, offered to the person's own dashboard only, and re-checked
// when answered (409 rate_limit_changed, nothing typed, if it is not still exactly that notice with that model).

const rateLimitScreen = `  Approaching rate limits
  Switch to gpt-6-luna for lower credit usage?

› 1. Switch to gpt-6-luna    Fast and affordable model for easier tasks
  2. Keep current model
  3. Keep current model (never show again)    Hide future rate limit reminders about
     this model.

  Press enter to confirm or esc to go back
`

func rateLimitScreenOf(t *testing.T, text string) promptScreen {
	t.Helper()
	s, ok := parseAgentScreen("codex", text)
	require.True(t, ok, "the screen parses as a menu")
	return s
}

func TestRateLimitNoticeIsRecognisedByItsStructureAlone(t *testing.T) {
	s := rateLimitScreenOf(t, rateLimitScreen)
	require.Len(t, s.Options, 3)
	assert.Equal(t, "gpt-6-luna", rateLimitNotice(s))
	s2 := rateLimitScreenOf(t, rateLimitScreen)
	markRateLimit("codex", &s2)
	assert.Equal(t, "gpt-6-luna", s2.rateLimitModel)
	markRateLimit("claude", &s2)
	s3 := rateLimitScreenOf(t, rateLimitScreen)
	s3.rateLimitModel = ""
	markRateLimit("claude", &s3)
	assert.Empty(t, s3.rateLimitModel, "only Codex's notice")

	look := func(name, text string) {
		t.Helper()
		s, ok := parseAgentScreen("codex", text)
		if !ok {
			return // not even a menu: nothing to offer
		}
		assert.Empty(t, rateLimitNotice(s), name)
	}
	look("another title", strings.Replace(rateLimitScreen, "Approaching rate limits", "Rate limit reached", 1))
	look("title with extra words in front", strings.Replace(rateLimitScreen, "  Approaching rate limits\n", "  Please note: Approaching rate limits\n", 1))
	look("a fourth option", strings.Replace(rateLimitScreen, "\n\n  Press enter", "\n  4. Remind me later\n\n  Press enter", 1))
	look("only two options", strings.Replace(rateLimitScreen, "  3. Keep current model (never show again)    Hide future rate limit reminders about\n     this model.\n", "", 1))
	look("options swapped", strings.Replace(strings.Replace(rateLimitScreen, "1. Switch to gpt-6-luna", "1. TMP", 1), "2. Keep current model", "2. Switch to gpt-6-luna", 1))
	look("choice 2 with other words", strings.Replace(rateLimitScreen, "2. Keep current model\n", "2. Keep current model and always allow\n", 1))
	look("choice 3 with other words", strings.Replace(rateLimitScreen, "(never show again)", "(for every model)", 1))
	look("choice 1 is not a switch", strings.Replace(rateLimitScreen, "1. Switch to gpt-6-luna", "1. Upgrade to gpt-6-luna", 1))
	look("a model with markup", strings.Replace(strings.Replace(rateLimitScreen, "Switch to gpt-6-luna", "Switch to <b>x</b>", 2), "gpt-6-luna for lower", "<b>x</b> for lower", 1))
	look("the question names another model", strings.Replace(rateLimitScreen, "Switch to gpt-6-luna for lower", "Switch to gpt-9-evil for lower", 1))
	look("a model with a control character", strings.Replace(rateLimitScreen, "gpt-6-luna    Fast", "gpt-6‮luna    Fast", 1))
}

func TestRateLimitNoticeIsOfferedToTheOwnDashboardAndAnsweredOnlyWhileItIsTheSameNotice(t *testing.T) {
	const sid = "00000000-0000-0000-0000-00000000a774"
	const name = "codex-ratelimit"
	server, _, term, ss := setupSessionsTestServer(t)
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "codex", AgentName: name, WorkingDir: "/tmp/test"}))
	term.addSession(name, "/tmp/test")
	fastPromptChecks(t)
	base := server.URL + "/api/sessions/live/" + name
	set := func(s string) { term.mu.Lock(); term.outputs[name] = s; term.mu.Unlock() }
	do := func(req *http.Request, dash bool) *http.Response {
		if dash {
			req.Header.Set("Sec-Fetch-Site", "same-origin") // the person's own page; without it a tool on this computer
			req.Header.Set("Origin", server.URL)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		return resp
	}
	chat := func(dash bool) promptScreen {
		req, err := http.NewRequest(http.MethodGet, base+"/chat?"+url.Values{"session_id": {sid}, "agent_type": {"codex"}, "after": {"1"}}.Encode(), nil)
		require.NoError(t, err)
		resp := do(req, dash)
		defer resp.Body.Close()
		var reply struct {
			PromptOptions promptScreen `json:"prompt_options"`
		}
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&reply))
		return reply.PromptOptions
	}
	answer := func(n int, label, model string, dash bool) (int, map[string]any) {
		payload := map[string]any{"n": n, "label": label, "session_id": sid, "agent_type": "codex"}
		if model != "" {
			payload["rate_limit_model"] = model
		}
		b, _ := json.Marshal(payload)
		req, err := http.NewRequest(http.MethodPost, base+"/answer-prompt", bytes.NewReader(b))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		resp := do(req, dash)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	const l1, l3 = "Switch to gpt-6-luna Fast and affordable model for easier tasks", "Keep current model (never show again) Hide future rate limit reminders about this model."

	set(rateLimitScreen)
	po := chat(true)
	require.NotNil(t, po.RateLimit, "the person's own dashboard is offered the notice")
	assert.Equal(t, "gpt-6-luna", po.RateLimit.Model)
	require.Len(t, po.Options, 3)
	assert.Nil(t, chat(false).RateLimit, "a tool on this computer, or a Hub viewer (no dashboard provenance), is not offered it")

	// the row's lasting choices, from the dashboard, while the screen is the same notice
	opt1, opt3 := po.Options[0].Label, po.Options[2].Label
	before := term.enters[name]
	code, body := answer(1, opt1, "gpt-6-luna", true)
	assert.NotEqual(t, "rate_limit_changed", body["code"], "the same notice and model: answered (code %d %v)", code, body)
	assert.Greater(t, term.enters[name], before, "its Enter was sent")

	// every other way: refused with rate_limit_changed, nothing typed
	for name2, c := range map[string]struct {
		n            int
		label, model string
		dash         bool
		screen       string
	}{
		"another model than the row drew":    {1, opt1, "gpt-9-evil", true, rateLimitScreen},
		"not the dashboard":                  {3, opt3, "gpt-6-luna", false, rateLimitScreen},
		"the screen changed to another menu": {1, opt1, "gpt-6-luna", true, strings.Replace(rateLimitScreen, "(never show again)", "(for every model)", 1)},
		"the notice is gone":                 {3, opt3, "gpt-6-luna", true, "  Working (3s • esc to interrupt)\n"},
	} {
		set(c.screen)
		before := term.enters[name]
		code, body := answer(c.n, c.label, c.model, c.dash)
		assert.Equal(t, http.StatusConflict, code, name2)
		if name2 != "the notice is gone" {
			assert.Equal(t, "rate_limit_changed", body["code"], name2)
		}
		assert.Equal(t, before, term.enters[name], name2+": nothing typed")
	}
	set(rateLimitScreen)
	code, body = answer(3, opt3, "gpt-9-evil", true)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "rate_limit_changed", body["code"], "a model the screen does not name")
	_ = l1
	_ = l3
}
