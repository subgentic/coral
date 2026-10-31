package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// #11432: the Operator's grant to a board's orchestrator: the switch, the seat the Operator names, the caps, the log, and the seat's wake and sleep of its own board's agents.

type orchRig struct {
	t      *testing.T
	server string
	h      *SessionsHandler
	ss     *store.SessionStore
	sid    map[string]string // member -> session id
	tok    map[string]string // member -> token
	term   *mockSessionTerminal
}

const orchBoard = "team"

func newOrchRig(t *testing.T) *orchRig {
	t.Helper()
	srv, h, term, ss := setupSessionsTestServer(t)
	// The routes on a router of their own whose middleware sets the identity layer's Actor as the real server's does: a token is an agent, a dashboard request is the Operator, nothing else is backed.
	rt := chi.NewRouter()
	rt.Use(testIdentity(h.db))
	rt.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if owner, ok := VerifiedSession(req.Context()); ok {
				req = withActor(req, Actor{Kind: ActorToken, Name: owner.SessionName, Session: owner.SessionName})
			} else if kind, _ := req.Context().Value(callerKindKey{}).(string); kind == callerDashCookie || kind == callerDashNoCookie {
				req = withActor(req, Actor{Kind: ActorOperator, Name: "Operator"})
			}
			next.ServeHTTP(w, req)
		})
	})
	rt.Get("/api/board/{project}/orchestrator-grant", h.OrchestratorGrant)
	rt.Put("/api/board/{project}/orchestrator-grant", h.OrchestratorGrant)
	rt.Get("/api/board/{project}/lifecycle-log", h.LifecycleLog)
	rt.Post("/api/board/{project}/agents/{subscriber}/wake", h.OrchestratorWake)
	rt.Post("/api/board/{project}/agents/{subscriber}/sleep", h.OrchestratorSleep)
	rt.Post("/api/sessions/launch", h.Launch)
	rt.Post("/api/sessions/launch-team", h.LaunchTeam)
	own := httptest.NewServer(rt)
	t.Cleanup(func() { own.Close(); srv.Close() })
	return &orchRig{t: t, server: own.URL, h: h, ss: ss, sid: map[string]string{}, tok: map[string]string{}, term: term}
}

// seat registers an agent session on a board (its live row and its subscription), asleep or awake.
func (r *orchRig) seat(member, title, boardName, agentType string, sleeping bool, n int) string {
	r.t.Helper()
	ctx := context.Background()
	sid := "eeeeeeee-1432-1b00-0000-" + strings.Repeat("0", 11) + string(rune('0'+n))
	ls := &store.LiveSession{SessionID: sid, AgentType: agentType, AgentName: member, WorkingDir: "/w", BoardName: &boardName}
	if sleeping {
		ls.IsSleeping = 1
	}
	require.NoError(r.t, r.ss.RegisterLiveSession(ctx, ls))
	_, err := r.h.bs.Subscribe(ctx, boardName, member, title, naming.SessionName(agentType, sid), nil, "all")
	require.NoError(r.t, err)
	if !sleeping && agentType != "terminal" {
		r.term.addSession(naming.SessionName(agentType, sid), "/w")
	}
	r.sid[member] = sid
	r.tok[member] = agentToken(r.t, r.h, sid, naming.SessionName(agentType, sid))
	return sid
}

func (r *orchRig) do(method, path, body string, client *http.Client, tok string) (int, map[string]any) {
	r.t.Helper()
	req, _ := http.NewRequest(method, r.server+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if tok != "" {
		req.Header.Set(store.SessionTokenHeader, tok)
	}
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	require.NoError(r.t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func (r *orchRig) operatorGrant(seatMember string, extra map[string]any) (int, map[string]any) {
	body := map[string]any{"enabled": true, "seat_session": r.sid[seatMember]}
	for k, v := range extra {
		body[k] = v
	}
	b, _ := json.Marshal(body)
	return r.do("PUT", "/api/board/"+orchBoard+"/orchestrator-grant", string(b), operatorClient, "")
}

func (r *orchRig) agentPost(who, action, target, body string) (int, map[string]any) {
	return r.do("POST", "/api/board/"+orchBoard+"/agents/"+url.PathEscape(target)+"/"+action, body, nil, r.tok[who])
}

// setBoard moves a live row to another board, as a re-seat or a stale row would.
func (r *orchRig) setBoard(sid, boardName string) {
	r.t.Helper()
	_, err := r.h.db.ExecContext(context.Background(), `UPDATE live_sessions SET board_name = ? WHERE session_id = ?`, boardName, sid)
	require.NoError(r.t, err)
}

func (r *orchRig) asleep(member string) bool {
	ls, err := r.ss.GetLiveSession(context.Background(), r.sid[member])
	require.NoError(r.t, err)
	return ls.IsSleeping == 1
}

// the usual board: the seat "Orchestrator", a sleeping "Dev", an idle "Dev2" and a plain terminal.
func (r *orchRig) usualBoard() {
	r.seat("Orchestrator", "Orchestrator", orchBoard, "claude", false, 1)
	r.seat("Dev", "Developer", orchBoard, "claude", true, 2)
	r.seat("Dev2", "Developer", orchBoard, "claude", false, 3)
}

func TestTheSwitchIsOffByDefaultAndOffMeansRefusedForTheSeat(t *testing.T) {
	r := newOrchRig(t)
	r.usualBoard()
	code, out := r.agentPost("Orchestrator", "wake", "Dev", "")
	assert.Equal(t, http.StatusForbidden, code)
	assert.Equal(t, "orchestrator_switch_off", out["code"])
	code, out = r.agentPost("Orchestrator", "sleep", "Dev2", "")
	assert.Equal(t, http.StatusForbidden, code)
	assert.Equal(t, "orchestrator_switch_off", out["code"])
	assert.True(t, r.asleep("Dev"), "nothing was done")
	// the Operator turns it on, then off: off is refused again at the next request
	code, _ = r.operatorGrant("Orchestrator", nil)
	require.Equal(t, http.StatusOK, code)
	b, _ := json.Marshal(map[string]any{"enabled": false})
	code, _ = r.do("PUT", "/api/board/"+orchBoard+"/orchestrator-grant", string(b), operatorClient, "")
	require.Equal(t, http.StatusOK, code)
	code, out = r.agentPost("Orchestrator", "wake", "Dev", "")
	assert.Equal(t, http.StatusForbidden, code, "switched off again: refused on the next request")
	assert.Equal(t, "orchestrator_switch_off", out["code"])
}

// Security 3: the switch, the seat and the caps are written only by the verified Operator, never from a claimed subscriber_id.
func TestTheGrantIsWrittenOnlyByTheVerifiedOperator(t *testing.T) {
	r := newOrchRig(t)
	r.usualBoard()
	body := func(extra string) string {
		return `{"enabled": true, "seat_session": "` + r.sid["Orchestrator"] + `", "subscriber_id": "Operator", "created_by": "Operator", "as": "Operator"` + extra + `}`
	}
	// an agent's token that claims to be the Operator in the body, the seat's own token, and a caller with no identity
	for name, c := range map[string]struct {
		client *http.Client
		tok    string
	}{"another agent's token": {nil, r.tok["Dev2"]}, "the seat's own token": {nil, r.tok["Orchestrator"]}, "no identity": {nil, ""}} {
		code, out := r.do("PUT", "/api/board/"+orchBoard+"/orchestrator-grant", body(""), c.client, c.tok)
		assert.Equal(t, http.StatusForbidden, code, name)
		assert.Equal(t, "operator_only", out["code"], name)
	}
	code, out := r.do("GET", "/api/board/"+orchBoard+"/orchestrator-grant", "", nil, r.tok["Orchestrator"])
	assert.Equal(t, http.StatusForbidden, code, "an agent cannot even read it")
	assert.Equal(t, "operator_only", out["code"])
	g, err := r.h.bs.GetOrchGrant(context.Background(), orchBoard)
	require.NoError(t, err)
	assert.False(t, g.Enabled, "no refused caller turned it on")

	code, out = r.operatorGrant("Orchestrator", map[string]any{"max_per_hour": 4, "max_live": 6, "idle_minutes": 9})
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, true, out["enabled"])
	assert.EqualValues(t, 4, out["max_per_hour"])
	assert.Equal(t, "Operator", out["set_by"])
	// the seat must be a live agent of THIS board
	other := r.seat("Elsewhere", "Developer", "other-board", "claude", false, 4)
	b, _ := json.Marshal(map[string]any{"enabled": true, "seat_session": other})
	code, _ = r.do("PUT", "/api/board/"+orchBoard+"/orchestrator-grant", string(b), operatorClient, "")
	assert.Equal(t, http.StatusBadRequest, code, "a session of another board cannot be the seat")
	b, _ = json.Marshal(map[string]any{"enabled": true, "seat_session": "no-such-session"})
	code, _ = r.do("PUT", "/api/board/"+orchBoard+"/orchestrator-grant", string(b), operatorClient, "")
	assert.Equal(t, http.StatusBadRequest, code)
	b, _ = json.Marshal(map[string]any{"enabled": true, "seat_session": r.sid["Orchestrator"], "max_per_hour": 100000})
	code, _ = r.do("PUT", "/api/board/"+orchBoard+"/orchestrator-grant", string(b), operatorClient, "")
	assert.Equal(t, http.StatusBadRequest, code, "a cap out of range")
}

// Security 2: the seat is exact: the verified token's session is the one the Operator named, its live row is on this board, re-resolved on every request.
func TestTheSeatIsExactAndReResolvedOnEveryRequest(t *testing.T) {
	r := newOrchRig(t)
	ctx := context.Background()
	r.usualBoard()
	// a second agent subscribes under the orchestrator's own name, and a member is simply TITLED Orchestrator
	imposter := r.seat("Orchestrator2", "Orchestrator", orchBoard, "claude", false, 5)
	_, err := r.h.bs.Subscribe(ctx, orchBoard, "Orchestrator", "Orchestrator", naming.SessionName("claude", imposter), nil, "all") // re-subscribes as the seat's name
	require.NoError(t, err)
	code, _ := r.operatorGrant("Orchestrator", nil)
	require.Equal(t, http.StatusOK, code)

	code, out := r.agentPost("Orchestrator2", "wake", "Dev", "")
	assert.Equal(t, http.StatusForbidden, code, "a member titled orchestrator, or one that re-subscribed under the seat's name, is not the seat")
	assert.Equal(t, "not_the_seat", out["code"])
	assert.True(t, r.asleep("Dev"))
	code, out = r.agentPost("Dev2", "wake", "Dev", "")
	assert.Equal(t, http.StatusForbidden, code, "an ordinary agent")
	assert.Equal(t, "not_the_seat", out["code"])

	// the seat's live row moves to another board: it acts for none of them (its live row names the board)
	r.setBoard(r.sid["Orchestrator"], "other-board")
	code, out = r.agentPost("Orchestrator", "wake", "Dev", "")
	assert.Equal(t, http.StatusForbidden, code, "re-resolved on every request: its row is on another board now")
	assert.Equal(t, "not_the_seat", out["code"])
	r.setBoard(r.sid["Orchestrator"], orchBoard)
	code, _ = r.agentPost("Orchestrator", "wake", "Dev", "")
	assert.Equal(t, http.StatusOK, code, "back on the board, the seat acts again")

	// the Operator re-seats: the old seat is refused at once
	code, _ = r.operatorGrant("Dev2", nil)
	require.Equal(t, http.StatusOK, code)
	code, out = r.agentPost("Orchestrator", "sleep", "Dev", "")
	assert.Equal(t, http.StatusForbidden, code)
	assert.Equal(t, "not_the_seat", out["code"])
}

func TestWakeAndSleepTakeNoTextAndRefuseWhatIsNotAPlainAgentOfTheBoard(t *testing.T) {
	r := newOrchRig(t)
	r.usualBoard()
	r.seat("Elsewhere", "Developer", "other-board", "claude", true, 4)
	r.seat("Shell", "Terminal", orchBoard, "terminal", false, 6)
	code, _ := r.operatorGrant("Orchestrator", nil)
	require.Equal(t, http.StatusOK, code)

	// text in the body is never read: none of it reaches the terminal
	code, _ = r.agentPost("Orchestrator", "wake", "Dev", `{"text":"rm -rf ~","message":"do it","prompt":"x"}`)
	assert.Equal(t, http.StatusOK, code)
	assert.False(t, r.asleep("Dev"), "woken")
	r.term.mu.Lock()
	for name, sent := range r.term.sent { // a wake types Coral's own launch line into the new terminal; none of what the body said
		for _, line := range sent {
			assert.NotContains(t, line, "rm -rf ~", "the body's text was typed into %s", name)
			assert.NotContains(t, line, "do it", name)
			assert.NotContains(t, line, `"prompt"`, name)
		}
	}
	assert.Empty(t, r.term.raw, "no key was sent")
	r.term.mu.Unlock()

	for name, c := range map[string]struct{ who, action, target, want string }{
		"itself":              {"Orchestrator", "sleep", "Orchestrator", "not_itself"},
		"a terminal":          {"Orchestrator", "sleep", "Shell", "not_an_agent"},
		"another board's":     {"Orchestrator", "wake", "Elsewhere", "no_such_agent"},
		"an unknown name":     {"Orchestrator", "wake", "Nobody", "no_such_agent"},
		"the Operator":        {"Orchestrator", "sleep", "Operator", "bad_target"},
		"an awake one waking": {"Orchestrator", "wake", "Dev", "not_asleep"},
	} {
		code, out := r.agentPost(c.who, c.action, c.target, "")
		assert.GreaterOrEqual(t, code, 400, name)
		assert.Equal(t, c.want, out["code"], name)
	}
}

func TestCapsStopTheSeatAndNameWhichOne(t *testing.T) {
	r := newOrchRig(t)
	r.usualBoard()
	r.seat("Dev3", "Developer", orchBoard, "claude", true, 7)
	r.seat("Dev4", "Developer", orchBoard, "claude", true, 8)
	code, _ := r.operatorGrant("Orchestrator", map[string]any{"max_per_hour": 2, "max_live": 20})
	require.Equal(t, http.StatusOK, code)
	for _, who := range []string{"Dev", "Dev3"} {
		code, _ := r.agentPost("Orchestrator", "wake", who, "")
		assert.Equal(t, http.StatusOK, code, who)
	}
	code, out := r.agentPost("Orchestrator", "wake", "Dev4", "")
	assert.Equal(t, http.StatusTooManyRequests, code)
	assert.Equal(t, "board_hourly_limit", out["code"], "the hourly cap, named")
	assert.True(t, r.asleep("Dev4"))
	// sleeping is not capped
	code, _ = r.agentPost("Orchestrator", "sleep", "Dev3", "")
	assert.Equal(t, http.StatusOK, code)

	// the live cap: raise the hourly one, lower the live one to what is live now
	code, _ = r.operatorGrant("Orchestrator", map[string]any{"max_per_hour": 50, "max_live": 3})
	require.Equal(t, http.StatusOK, code)
	code, out = r.agentPost("Orchestrator", "wake", "Dev4", "")
	assert.Equal(t, http.StatusTooManyRequests, code, "Orchestrator, Dev, Dev2 are live: three")
	assert.Equal(t, "board_live_limit", out["code"])
}

// Security 7: two requests at once cannot pass the same cap.
func TestParallelWakesCannotPassTheSameCap(t *testing.T) {
	r := newOrchRig(t)
	r.usualBoard()
	names := []string{"S1", "S2", "S3", "S4", "S5", "S6"}
	for i, n := range names {
		r.seat(n, "Developer", orchBoard, "claude", true, 10+i)
	}
	code, _ := r.operatorGrant("Orchestrator", map[string]any{"max_per_hour": 2, "max_live": 50})
	require.Equal(t, http.StatusOK, code)
	var wg sync.WaitGroup
	var mu sync.Mutex
	ok, limited := 0, 0
	for _, n := range names {
		wg.Add(1)
		go func(n string) {
			defer wg.Done()
			code, out := r.agentPost("Orchestrator", "wake", n, "")
			mu.Lock()
			defer mu.Unlock()
			switch {
			case code == http.StatusOK:
				ok++
			case code == http.StatusTooManyRequests && out["code"] == "board_hourly_limit":
				limited++
			default:
				t.Errorf("%s: %d %v", n, code, out)
			}
		}(n)
	}
	wg.Wait()
	assert.Equal(t, 2, ok, "six parallel wakes pass a cap of two exactly twice")
	assert.Equal(t, 4, limited)
}

func TestSleepRefusesAnAgentThatWaitsOnThePersonOrIsWorking(t *testing.T) {
	r := newOrchRig(t)
	ctx := context.Background()
	r.usualBoard()
	code, _ := r.operatorGrant("Orchestrator", map[string]any{"idle_minutes": 5})
	require.Equal(t, http.StatusOK, code)

	// an agent with an open wait for the Operator
	_, err := r.h.bs.RegisterWait(ctx, orchBoard, "Dev2", naming.SessionName("claude", r.sid["Dev2"]), board.WaitOperator, "", "may I delete it?", time.Hour)
	require.NoError(t, err)
	code, out := r.agentPost("Orchestrator", "sleep", "Dev2", "")
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "waiting_for_the_person", out["code"])
	assert.Contains(t, out["message"], "Operator", "the refusal says why")
	require.NoError(t, r.h.bs.CancelActiveWait(ctx, orchBoard, "Dev2"))

	// an open ask to the Operator
	q, err := r.h.bs.PostMessage(ctx, orchBoard, "Dev2", "@Operator which one?", nil)
	require.NoError(t, err)
	_, err = r.h.bs.Subscribe(ctx, orchBoard, "Operator", "Operator", "", nil, "all")
	require.NoError(t, err)
	require.NoError(t, r.h.bs.RecordAsk(ctx, orchBoard, q, []string{"Operator"}))
	code, out = r.agentPost("Orchestrator", "sleep", "Dev2", "")
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "waiting_for_the_person", out["code"])

	// a working agent (a turn that started a moment ago) is refused with the minutes; idle for long enough it may be put to sleep
	r.seat("Dev5", "Developer", orchBoard, "claude", false, 9)
	now := time.Now().UTC()
	d5 := r.sid["Dev5"]
	bash := "Bash"
	_, err = r.h.ts.InsertAgentEvent(ctx, &store.AgentEvent{AgentName: "Dev5", SessionID: &d5, EventType: "tool_use", ToolName: &bash, Summary: "Bash", RefID: &bash, CreatedAt: now.Add(-30 * time.Second).Format(store.ISOFormat)})
	require.NoError(t, err)
	code, out = r.agentPost("Orchestrator", "sleep", "Dev5", "")
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "working", out["code"])
	assert.Contains(t, out["message"], "5 minutes")
	assert.False(t, r.asleep("Dev5"))
}

func TestEveryActionIsLoggedAndSaidOnTheBoard(t *testing.T) {
	r := newOrchRig(t)
	ctx := context.Background()
	r.usualBoard()
	code, _ := r.operatorGrant("Orchestrator", nil)
	require.Equal(t, http.StatusOK, code)
	code, _ = r.agentPost("Orchestrator", "wake", "Dev", "")
	require.Equal(t, http.StatusOK, code)
	code, _ = r.agentPost("Orchestrator", "sleep", "Dev2", "")
	require.Equal(t, http.StatusOK, code)
	log, err := r.h.bs.LifecycleLog(ctx, orchBoard, 10)
	require.NoError(t, err)
	var kinds []string
	for _, e := range log {
		if e.Kind == "grant" {
			continue
		}
		kinds = append(kinds, e.Kind+" "+e.Actor+" "+e.Target+" "+e.Status)
	}
	assert.ElementsMatch(t, []string{"wake Orchestrator Dev ok", "sleep Orchestrator Dev2 ok"}, kinds)
	// Security's SHOULD: the grant's own row names the seat and the caps; a change of caps alone is a row of its own
	grants := func() []string {
		var out []string
		l, err := r.h.bs.LifecycleLog(ctx, orchBoard, 50)
		require.NoError(t, err)
		for _, e := range l {
			if e.Kind == "grant" {
				out = append(out, e.Target)
			}
		}
		return out
	}
	assert.Equal(t, []string{"switch on, seat Orchestrator, 10 an hour, 8 live, idle 5 min"}, grants())
	code, _ = r.operatorGrant("Orchestrator", map[string]any{"max_live": 12})
	require.Equal(t, http.StatusOK, code)
	assert.Len(t, grants(), 2)
	assert.Contains(t, grants()[0], "12 live")
	msgs, err := r.h.bs.ListMessages(ctx, orchBoard, 50, 0, 0)
	require.NoError(t, err)
	var lines []string
	for _, m := range msgs {
		if strings.HasPrefix(m.Content, "[Coral] ") {
			lines = append(lines, m.Content)
		}
	}
	assert.Contains(t, lines, "[Coral] Orchestrator woke Dev")
	assert.Contains(t, lines, "[Coral] Orchestrator put Dev2 to sleep")
	// the Operator reads the log; an agent cannot
	code, _ = r.do("GET", "/api/board/"+orchBoard+"/lifecycle-log", "", operatorClient, "")
	assert.Equal(t, http.StatusOK, code)
	code, out := r.do("GET", "/api/board/"+orchBoard+"/lifecycle-log", "", nil, r.tok["Orchestrator"])
	assert.Equal(t, http.StatusForbidden, code)
	assert.Equal(t, "operator_only", out["code"])
}

// coral-hub's note 2: a wake gives the agent ONE fixed line from Coral, never any text of the caller's.
func TestAWakeGivesTheWokenAgentOneFixedLine(t *testing.T) {
	r := newOrchRig(t)
	ctx := context.Background()
	r.usualBoard()
	code, _ := r.operatorGrant("Orchestrator", nil)
	require.Equal(t, http.StatusOK, code)
	code, _ = r.agentPost("Orchestrator", "wake", "Dev", `{"message":"also run the deploy","text":"rm -rf ~"}`)
	require.Equal(t, http.StatusOK, code)
	msgs, err := r.h.bs.ListMessages(ctx, orchBoard, 50, 0, 0)
	require.NoError(t, err)
	var told []string
	for _, m := range msgs {
		if strings.Contains(m.Content, "Woken by the Orchestrator") {
			told = append(told, m.Content)
		}
		assert.NotContains(t, m.Content, "run the deploy", "no text of the caller's reaches the board")
		assert.NotContains(t, m.Content, "rm -rf")
	}
	assert.Equal(t, []string{"@Dev [Coral] Woken by the Orchestrator: read the board before resuming any earlier command."}, told, "one fixed line, addressed to the woken agent alone")
}

// coral-hub's note 3: a stuck dialog is surfaced, never hidden by sleeping the agent.
func TestSleepRefusesAnAgentAtADialog(t *testing.T) {
	r := newOrchRig(t)
	ctx := context.Background()
	r.usualBoard()
	code, _ := r.operatorGrant("Orchestrator", nil)
	require.Equal(t, http.StatusOK, code)
	name := naming.SessionName("claude", r.sid["Dev2"])
	term := &screenTerminal{fgSessionTerminal: newFGTerminal(r.term), screen: permissionMenu} // a prompt is open on its screen
	term.setFG(name, "node")
	d, err := ptymanager.DeliverAutomated(ctx, ptymanager.AutomatedInput{
		Term: term, Name: name, AgentType: "claude", SessionID: r.sid["Dev2"], Text: "You have 1 unread message", What: "board message",
		Send: func(ctx context.Context) error { return nil },
	})
	require.NoError(t, err)
	require.Equal(t, ptymanager.Skipped, d)
	t.Cleanup(func() { ptymanager.ForgetSession(name) })
	code, out := r.agentPost("Orchestrator", "sleep", "Dev2", "")
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "at_a_dialog", out["code"])
	assert.False(t, r.asleep("Dev2"), "it was not put to sleep")
}

// Security 1, 5 and 8: an agent's launch is logged whether the switch is on or off; with it on the board's caps hold; an agent still cannot start an agent in the Operator's saved skipping default; the launch stays on its own board.
func TestAnAgentsLaunchIsLoggedAndHeldToTheCapsWhenTheSwitchIsOn(t *testing.T) {
	r := newOrchRig(t)
	ctx := context.Background()
	r.usualBoard()
	work := t.TempDir()
	launch := func(who, boardName string) (int, map[string]any) {
		b, _ := json.Marshal(map[string]any{"working_dir": work, "agent_type": "claude", "board_id": boardName, "display_name": "Helper"})
		return r.do("POST", "/api/sessions/launch", string(b), nil, r.tok[who])
	}
	// the switch is off: a helper launch by any agent on its own board still goes, and is logged with its actor and target
	code, out := launch("Dev2", orchBoard)
	require.Equal(t, http.StatusOK, code, out)
	log, err := r.h.bs.LifecycleLog(ctx, orchBoard, 10)
	require.NoError(t, err)
	require.Len(t, log, 1)
	assert.Equal(t, board.LifecycleLaunch, log[0].Kind)
	assert.Equal(t, "Dev2", log[0].Actor)
	assert.Equal(t, "Helper", log[0].Target)
	assert.Equal(t, "ok", log[0].Status)
	msgs, _ := r.h.bs.ListMessages(ctx, orchBoard, 50, 0, 0)
	for _, m := range msgs {
		assert.NotContains(t, m.Content, "started Helper", "with the switch off no line is said on the board")
	}

	// the switch on, a cap of two launches and wakes an hour: the log already holds one, one more passes, the next is refused with the cap named and nothing started
	code, _ = r.operatorGrant("Orchestrator", map[string]any{"max_per_hour": 2, "max_live": 50})
	require.Equal(t, http.StatusOK, code)
	before, _ := r.ss.CountActiveLiveSessions(ctx)
	code, out = launch("Dev2", orchBoard)
	require.Equal(t, http.StatusOK, code, out)
	code, out = launch("Dev2", orchBoard)
	assert.Equal(t, http.StatusTooManyRequests, code)
	assert.Equal(t, "board_hourly_limit", out["code"])
	after, _ := r.ss.CountActiveLiveSessions(ctx)
	assert.Equal(t, before+1, after, "the refused launch started nothing")
	msgs, _ = r.h.bs.ListMessages(ctx, orchBoard, 50, 0, 0)
	said := false
	for _, m := range msgs {
		if strings.Contains(m.Content, "[Coral] Dev2 started Helper") {
			said = true
		}
	}
	assert.True(t, said, "with the switch on a launch is said on the board")

	// another board's: an agent still starts agents only on its own board
	r.seat("Elsewhere", "Developer", "other-board", "claude", false, 4)
	code, out = launch("Dev2", "other-board")
	assert.Equal(t, http.StatusForbidden, code, "another board's: %v", out)
	assert.Equal(t, "forbidden_for_agent", out["code"])

	// the Operator's saved default skips the prompts: an agent's launch is refused with the switch on, as before
	require.NoError(t, r.ss.SetSetting(ctx, "default_permission_mode", "bypassPermissions"))
	require.NoError(t, r.h.bs.SetOrchGrant(ctx, board.OrchGrant{Project: orchBoard, Enabled: true, SeatSession: r.sid["Orchestrator"], MaxPerHour: 50, MaxLive: 50, IdleMin: 5}, "Operator"))
	beforeSkip, _ := r.ss.CountActiveLiveSessions(ctx)
	code, out = launch("Orchestrator", orchBoard)
	assert.Equal(t, http.StatusForbidden, code, "an agent cannot inherit a saved default that skips the permission prompts: %v", out)
	assert.Contains(t, out["error"], "permission", "the refusal says why")
	started, _ := r.ss.CountActiveLiveSessions(ctx)
	assert.Equal(t, beforeSkip, started, "nothing more was started")

}

// The Orchestrator's ruling on #11432: a team launch is not a way round the log and the caps. Each member an agent's launch-team starts is logged, and with the switch on counted against the same caps; a member over the cap is not started and says which.
func TestAnAgentsTeamLaunchIsLoggedAndCountedMemberByMember(t *testing.T) {
	r := newOrchRig(t)
	ctx := context.Background()
	r.usualBoard()
	work := t.TempDir()
	team := func(who string, names ...string) (int, map[string]any) {
		agents := make([]map[string]any, len(names))
		for i, n := range names {
			agents[i] = map[string]any{"name": n, "prompt": "work"}
		}
		b, _ := json.Marshal(map[string]any{"board_id": orchBoard, "working_dir": work, "agent_type": "claude", "agents": agents})
		return r.do("POST", "/api/sessions/launch-team", string(b), nil, r.tok[who])
	}
	members := func(out map[string]any) []map[string]any {
		var ms []map[string]any
		for _, a := range out["agents"].([]any) {
			ms = append(ms, a.(map[string]any))
		}
		return ms
	}
	// the switch off: both members start and both are in the log
	code, out := team("Dev2", "TeamA", "TeamB")
	require.Equal(t, http.StatusOK, code, out)
	log, err := r.h.bs.LifecycleLog(ctx, orchBoard, 10)
	require.NoError(t, err)
	require.Len(t, log, 2)
	for _, e := range log {
		assert.Equal(t, board.LifecycleLaunch, e.Kind)
		assert.Equal(t, "Dev2", e.Actor)
		assert.Equal(t, "ok", e.Status)
	}
	// the switch on with room for one more this hour: the first member of the next team starts, the second is refused with the cap named
	code, _ = r.operatorGrant("Orchestrator", map[string]any{"max_per_hour": 3, "max_live": 50})
	require.Equal(t, http.StatusOK, code)
	before, _ := r.ss.CountActiveLiveSessions(ctx)
	code, out = team("Orchestrator", "TeamC", "TeamD")
	require.Equal(t, http.StatusOK, code, out)
	ms := members(out)
	require.Len(t, ms, 2)
	assert.Nil(t, ms[0]["error"], "the first fits under the cap")
	assert.Equal(t, "board_hourly_limit", ms[1]["code"])
	assert.Contains(t, ms[1]["error"], "3 launches and wakes an hour")
	after, _ := r.ss.CountActiveLiveSessions(ctx)
	assert.Equal(t, before+1, after, "only the member under the cap started")
	// a team whose every member is over the cap starts nobody
	code, out = team("Orchestrator", "TeamE")
	assert.NotEqual(t, http.StatusOK, code, out)
	assert.Equal(t, "board_hourly_limit", members(out)[0]["code"])
	again, _ := r.ss.CountActiveLiveSessions(ctx)
	assert.Equal(t, after, again)
}

// Security's SHOULD on #11432: the live cap holds for a team launch too: a board with room for one more live agent starts one member of a team and refuses the rest with the cap named.
func TestAnAgentsTeamLaunchIsHeldToTheLiveCap(t *testing.T) {
	r := newOrchRig(t)
	ctx := context.Background()
	r.usualBoard() // Orchestrator and Dev2 awake, Dev asleep: two live
	code, _ := r.operatorGrant("Orchestrator", map[string]any{"max_per_hour": 50, "max_live": 3})
	require.Equal(t, http.StatusOK, code)
	b, _ := json.Marshal(map[string]any{"board_id": orchBoard, "working_dir": t.TempDir(), "agent_type": "claude", "agents": []map[string]any{{"name": "LiveA", "prompt": "work"}, {"name": "LiveB", "prompt": "work"}}})
	before, _ := r.ss.CountActiveLiveSessions(ctx)
	code, out := r.do("POST", "/api/sessions/launch-team", string(b), nil, r.tok["Orchestrator"])
	require.Equal(t, http.StatusOK, code, out)
	ms := out["agents"].([]any)
	require.Len(t, ms, 2)
	assert.Nil(t, ms[0].(map[string]any)["error"], "one fits under the live cap of 3")
	refused := ms[1].(map[string]any)
	assert.Equal(t, "board_live_limit", refused["code"])
	assert.Contains(t, refused["error"], "3 live agents")
	after, _ := r.ss.CountActiveLiveSessions(ctx)
	assert.Equal(t, before+1, after)
}
