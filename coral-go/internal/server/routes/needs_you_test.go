package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #11596: GET /api/needs-you is what waits for the Operator in one read, for the Hub's phone push: waiting agents (the sessions handler's rows, here a seam), questions and waits, proposals, and unread files for
// review, each as one cleaned and cut line with its team, a stable id and a time, a count that matches the Inbox's for those four, and a cursor so a poller gets only what is newer.

func readNeedsYou(t *testing.T, h *BoardHandler, query string, mod func(*http.Request) *http.Request) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/needs-you"+query, nil)
	if mod != nil {
		req = mod(req)
	}
	w := httptest.NewRecorder()
	h.NeedsYou(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func needsYouItems(out map[string]any) []map[string]any {
	var items []map[string]any
	for _, v := range out["items"].([]any) {
		items = append(items, v.(map[string]any))
	}
	return items
}

func TestNeedsYouCountsEverySourceAndCleansAndCutsTheLines(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	h.SetNeedsYouAgents(func(*http.Request) ([]NeedsYouItem, error) {
		return []NeedsYouItem{{Kind: "agent", From: "Dev", Line: "Wants to run a command", Team: "team", ID: "agent:s1", At: time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)}}, nil
	})
	q, err := bs.PostMessage(ctx, "team", "Lead", "@Operator may I \u202eproceed?\n"+strings.Repeat("long ", 100), nil)
	require.NoError(t, err)
	require.NoError(t, bs.RecordAsk(ctx, "team", q, []string{"Operator"}))
	_, err = bs.RegisterWait(ctx, "team", "Dev", "claude-x", board.WaitOperator, "", "may I delete the old table?", time.Hour)
	require.NoError(t, err)
	_, _, err = bs.CreateProposal(ctx, board.ProposalInput{Board: "team", Kind: board.ProposalTask, Title: "Add the export", Payload: json.RawMessage(`{"title":"Add the export"}`), Proposer: "Lead"})
	require.NoError(t, err)

	code, out := readNeedsYou(t, h, "", asPerson)
	require.Equal(t, http.StatusOK, code, out)
	assert.EqualValues(t, 4, out["count"])
	counts := out["counts"].(map[string]any)
	assert.EqualValues(t, 1, counts["agent"])
	assert.EqualValues(t, 1, counts["question"])
	assert.EqualValues(t, 1, counts["wait"])
	assert.EqualValues(t, 1, counts["proposal"])
	assert.EqualValues(t, 0, counts["review"])
	assert.Equal(t, []any{"failed_runs", "welcome", "unrecorded_agents"}, out["not_included"], "what the Inbox counts and this read cannot see is named")
	byKind := map[string]map[string]any{}
	for _, it := range needsYouItems(out) {
		byKind[it["kind"].(string)] = it
		assert.Equal(t, "team", it["team"])
		assert.NotEmpty(t, it["id"])
		assert.NotEmpty(t, it["at"])
	}
	line := byKind["question"]["line"].(string)
	assert.NotContains(t, line, "\u202e", "a hidden character is out")
	assert.NotContains(t, line, "\n", "one line")
	assert.LessOrEqual(t, len([]rune(line)), needsYouLineMax, "cut")
	assert.Equal(t, "Lead", byKind["question"]["from"])
	assert.Equal(t, "Add the export", byKind["proposal"]["line"])
	assert.Equal(t, "may I delete the old table?", byKind["wait"]["line"])
}

func TestNeedsYouCursorIsAPlaceInTheOrderAndGivesWhatIsStrictlyAfterIt(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	ask := func(text string) {
		q, err := bs.PostMessage(ctx, "team", "Lead", "@Operator "+text, nil)
		require.NoError(t, err)
		require.NoError(t, bs.RecordAsk(ctx, "team", q, []string{"Operator"}))
	}
	ask("first?")
	_, out := readNeedsYou(t, h, "", asPerson)
	cursor, _ := out["cursor"].(string)
	require.Contains(t, cursor, "|", "a time and an id")
	_, out = readNeedsYou(t, h, "?after="+cursor, asPerson)
	assert.Empty(t, needsYouItems(out), "nothing after the newest item")
	assert.Equal(t, cursor, out["cursor"], "and the cursor stays")
	ask("second?") // recorded to the same second as the first, likely: told apart by id
	_, out = readNeedsYou(t, h, "?after="+cursor, asPerson)
	items := needsYouItems(out)
	require.Len(t, items, 1, "the second item comes once, whether or not it shares the first's second")
	assert.Contains(t, items[0]["line"], "second?")
	_, out = readNeedsYou(t, h, "?after="+out["cursor"].(string), asPerson)
	assert.Empty(t, needsYouItems(out), "and not again")
	// a bare time is still taken, and includes what is at that time
	bare := strings.SplitN(cursor, "|", 2)[0]
	_, out = readNeedsYou(t, h, "?after="+bare, asPerson)
	assert.NotEmpty(t, needsYouItems(out), "a bare time includes the items at it")
	for _, bad := range []string{"yesterday", bare + "|", "|abc"} {
		code, _ := readNeedsYou(t, h, "?after="+bad, asPerson)
		assert.Equal(t, http.StatusBadRequest, code, bad)
	}
	code, _ := readNeedsYou(t, h, "?limit=0", asPerson)
	assert.Equal(t, http.StatusBadRequest, code)
	_, out = readNeedsYou(t, h, "?after=2999-01-01T00:00:00Z|x", asPerson)
	assert.Empty(t, needsYouItems(out), "a cursor from the future gives nothing")
	assert.EqualValues(t, 2, out["count"])
}

// QA's MUST on #11604: items that share the cursor's time are told apart by id, so a poller reading until a poll is short reaches every one, once.
func TestNeedsYouItemsInOneInstantAreAllReachedWithAnyLimit(t *testing.T) {
	h, _ := operatorAsksRig(t)
	at := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
	var rows []NeedsYouItem
	for _, id := range []string{"agent:c", "agent:a", "agent:b"} {
		rows = append(rows, NeedsYouItem{Kind: "agent", From: "x", Line: "waits", Team: "team", ID: id, At: at})
	}
	h.SetNeedsYouAgents(func(*http.Request) ([]NeedsYouItem, error) { return rows, nil })
	for _, limit := range []string{"1", "2", "3", "50"} {
		var got []string
		cursor := "1970-01-01T00:00:00Z" // a bare time, the first form
		for poll := 0; poll < 6; poll++ {
			_, out := readNeedsYou(t, h, "?limit="+limit+"&after="+cursor, asPerson)
			for _, it := range needsYouItems(out) {
				got = append(got, it["id"].(string))
			}
			cursor = out["cursor"].(string)
		}
		assert.Equal(t, []string{"agent:a", "agent:b", "agent:c"}, got, "limit "+limit+": each of the three, once, in order")
	}
}

func TestNeedsYouSaysWhenASourceCouldNotBeRead(t *testing.T) {
	h, _ := operatorAsksRig(t)
	h.SetNeedsYouAgents(func(*http.Request) ([]NeedsYouItem, error) { return nil, errors.New("terminal gone") })
	code, out := readNeedsYou(t, h, "", asPerson)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, []any{"agents"}, out["unread_sources"], "missing from the count, not zero")
}

func TestNeedsYouIsTheOperatorsAlone(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	q, err := bs.PostMessage(ctx, "team", "Lead", "@Operator may I?", nil)
	require.NoError(t, err)
	require.NoError(t, bs.RecordAsk(ctx, "team", q, []string{"Operator"}))
	code, out := readNeedsYou(t, h, "", nil)
	assert.Equal(t, http.StatusForbidden, code, "not a person: an agent, a script")
	assert.NotContains(t, out, "items")
	code, _ = readNeedsYou(t, h, "", func(r *http.Request) *http.Request {
		r.Header.Set("X-Coral-Via-Tunnel", "1")
		return asPerson(r)
	})
	assert.Equal(t, http.StatusForbidden, code, "through the Hub, only the owner")
}

func TestNeedsYouCountsOnlyUnreadFilesForReview(t *testing.T) {
	e := newReviewEnv(t, true)
	e.tag(t, `["for review"]`)
	count := func() (int, map[string]any) {
		req := asPerson(httptest.NewRequest(http.MethodGet, "/api/needs-you", nil))
		w := httptest.NewRecorder()
		e.h.NeedsYou(w, req)
		var out map[string]any
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return int(out["count"].(float64)), out
	}
	n, out := count()
	require.Equal(t, 1, n)
	it := needsYouItems(out)[0]
	assert.Equal(t, "review", it["kind"])
	assert.Equal(t, "plan.md", it["line"])
	e.tag(t, `["for review", "read"]`)
	n, _ = count()
	assert.Equal(t, 0, n, "a file the Operator opened is listed in Needs you but not counted")
	e.tag(t, `["for review"]`)
	code, _ := e.decide(t, `{"decision":"ignore"}`)
	require.Equal(t, http.StatusOK, code)
	n, _ = count()
	assert.Equal(t, 0, n, "an ignored file is not waiting")
	code, _ = e.decide(t, `{"decision":"unignore"}`)
	require.Equal(t, http.StatusOK, code)
	n, _ = count()
	assert.Equal(t, 1, n, "unignored: waiting again")
	code, _ = e.decide(t, `{"decision":"deny"}`)
	require.Equal(t, http.StatusOK, code)
	n, _ = count()
	assert.Equal(t, 0, n, "a denied file is not waiting")
}

// #11985 (the operator): after Request changes a file LEAVES Needs you (it is the agent's turn; nothing waits on the person), so /api/needs-you, its count and the phone push do not list it; it stays tagged for
// review with "changes requested" so it is findable in Artifacts and the goal. The agent's next version is a NEW unread item that counts.
func TestNeedsYouDoesNotListAFileWhoseChangesWereRequested(t *testing.T) {
	e := newReviewEnv(t, true)
	e.tag(t, `["for review"]`)
	count := func() int {
		req := asPerson(httptest.NewRequest(http.MethodGet, "/api/needs-you", nil))
		w := httptest.NewRecorder()
		e.h.NeedsYou(w, req)
		var out map[string]any
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return int(out["count"].(float64))
	}
	require.Equal(t, 1, count(), "waiting for the Operator's review")
	code, _ := e.decide(t, `{"decision":"changes"}`)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, 0, count(), "after Request changes the file is the agent's turn: not listed, not counted")
	e.tag(t, `["for review", "changes requested"]`)
	assert.Equal(t, 0, count(), "still tagged for review with the changes requested, and still not waiting on the Operator")
}

// Security's SHOULD on #11596: a line is agent text that goes to a phone through the Hub, so a secret in it is redacted before it is cut, in a question, a proposal's title and a file's name alike.
func TestNeedsYouRedactsSecretsInEveryLineBeforeTheCut(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	token := "ghp_" + strings.Repeat("aB3dE5gH7j", 4) // a GitHub token's shape
	q, err := bs.PostMessage(ctx, "team", "Lead", "@Operator "+strings.Repeat("x", needsYouLineMax-20)+" my token is "+token+" ok?", nil)
	require.NoError(t, err)
	require.NoError(t, bs.RecordAsk(ctx, "team", q, []string{"Operator"}))
	_, _, err = bs.CreateProposal(ctx, board.ProposalInput{Board: "team", Kind: board.ProposalTask, Title: "use " + token, Payload: json.RawMessage(`{"title":"t"}`), Proposer: "Lead"})
	require.NoError(t, err)
	code, out := readNeedsYou(t, h, "", asPerson)
	require.Equal(t, http.StatusOK, code)
	raw, _ := json.Marshal(out)
	assert.NotContains(t, string(raw), token, "the whole token is gone")
	assert.NotContains(t, string(raw), token[:20], "and so is the part a cut would leave")
	assert.EqualValues(t, 2, out["count"])
}

// QA's SHOULD on #11596: a poll that finds more new items than the limit returns the OLDEST first and the cursor moves only as far as the last one given, so reading until a poll is short loses nothing.
func TestNeedsYouABurstBiggerThanTheLimitIsReadInSeveralPollsAndNothingIsSkipped(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	ask := func(text string) {
		q, err := bs.PostMessage(ctx, "team", "Lead", "@Operator "+text, nil)
		require.NoError(t, err)
		require.NoError(t, bs.RecordAsk(ctx, "team", q, []string{"Operator"}))
		time.Sleep(1100 * time.Millisecond) // the ask's time is kept to the second
	}
	ask("zero?")
	_, out := readNeedsYou(t, h, "", asPerson)
	cursor := out["cursor"].(string)
	for _, t2 := range []string{"one?", "two?", "three?"} {
		ask(t2)
	}
	seen := map[string]bool{}
	for poll := 0; poll < 6; poll++ {
		_, out = readNeedsYou(t, h, "?limit=2&after="+cursor, asPerson)
		for _, it := range needsYouItems(out) {
			seen[it["id"].(string)] = true
		}
		cursor = out["cursor"].(string)
	}
	assert.Len(t, seen, 3, "the three of the burst, every one read, once: %v", seen)
	_, out = readNeedsYou(t, h, "?limit=1&after="+out["cursor"].(string), asPerson)
	assert.Empty(t, needsYouItems(out), "and then nothing")
}

func TestNeedsYouLimitIsCappedAtFifty(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	for i := 0; i < 55; i++ {
		q, err := bs.PostMessage(ctx, "team", "Lead", "@Operator ask", nil)
		require.NoError(t, err)
		require.NoError(t, bs.RecordAsk(ctx, "team", q, []string{"Operator"}))
	}
	_, out := readNeedsYou(t, h, "?limit=1000", asPerson)
	assert.Len(t, needsYouItems(out), needsYouItemsMax)
	assert.EqualValues(t, 55, out["count"])
}

// The agents' filter: awake, not archived, waiting for input; a row with no time for its wait gets one.
func TestNeedsYouAgentItemsAreTheAwakeWaitingOnes(t *testing.T) {
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	row := func(sid string, wait, sleeping, archived bool, since any) map[string]any {
		return map[string]any{"session_id": sid, "display_name": "Agent " + sid, "waiting_for_input": wait, "sleeping": sleeping, "archived": archived, "waiting_summary": "Wants to run a command", "board_project": "team", "waiting_since": since}
	}
	got := needsYouAgentItems([]map[string]any{
		row("a", true, false, false, "2026-10-31T11:00:00Z"),
		row("b", true, true, false, "2026-10-31T11:00:00Z"),
		row("c", true, false, true, "2026-10-31T11:00:00Z"),
		row("d", false, false, false, nil),
		row("e", true, false, false, nil),
	}, now)
	require.Len(t, got, 2, "the sleeping, archived and not-waiting agents are not waiting on the Operator: %v", got)
	assert.Equal(t, "agent:a", got[0].ID)
	assert.Equal(t, "2026-10-31T11:00:00Z", got[0].At[:20])
	assert.Equal(t, "agent:e", got[1].ID)
	assert.Equal(t, now.Format(time.RFC3339Nano), got[1].At, "no start time: waiting now")
	assert.Equal(t, "Wants to run a command", got[0].Line)
}

// #12026 (the Operator): after the Operator comments on a file, an agent's reply in that thread is NOT a new item: the file's own row says "new comments" (the row's new_comments, the number of unseen replies) and
// becomes unread again, counted once as that same row, in /api/needs-you (so the phone push) as in the list. Opening the thread clears it (commentNews no longer has the file).
func TestNeedsYouAFileWithNewCommentsIsUnreadAgainAsTheSameRow(t *testing.T) {
	e := newReviewEnv(t, true)
	news := map[string]int{}
	e.h.SetCommentNews(func(context.Context) (map[string]int, error) { return news, nil })
	count := func() (int, map[string]any) {
		req := asPerson(httptest.NewRequest(http.MethodGet, "/api/needs-you", nil))
		w := httptest.NewRecorder()
		e.h.NeedsYou(w, req)
		var out map[string]any
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return int(out["count"].(float64)), out
	}
	person := chi.NewRouter() // the Operator's own list: the dashboard's cookie
	person.Get("/api/board/{project}/artifacts", func(w http.ResponseWriter, req *http.Request) { e.h.ListTeamArtifacts(w, asPerson(req)) })
	psrv := httptest.NewServer(person)
	t.Cleanup(psrv.Close)
	listAs := func(srv string) []map[string]any {
		resp, err := http.Get(srv + "/api/board/alpha/artifacts")
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		var got []map[string]any
		for _, a := range out["artifacts"].([]any) {
			got = append(got, a.(map[string]any))
		}
		return got
	}
	rows := func() []map[string]any { return listAs(psrv.URL) }

	e.tag(t, `["for review", "read"]`)
	n, _ := count()
	require.Equal(t, 0, n, "opened: read, not counted")
	assert.Nil(t, rows()[0]["new_comments"], "no news, no field")

	news[e.id] = 2
	n, out := count()
	assert.Equal(t, 1, n, "an agent replied in the Operator's thread: the read file is unread again, counted once")
	items := needsYouItems(out)
	require.Len(t, items, 1, "the same row, not a new item")
	assert.Equal(t, "review", items[0]["kind"])
	assert.Equal(t, "review:alpha:"+e.id, items[0]["id"], "the file's own row")
	assert.EqualValues(t, 2, items[0]["new_comments"])
	assert.EqualValues(t, 1, out["counts"].(map[string]any)["review"])
	assert.EqualValues(t, 2, rows()[0]["new_comments"], "and the list says so for the page")

	e.tag(t, `["for review"]`)
	n, _ = count()
	assert.Equal(t, 1, n, "an unread file with new comments is still ONE")

	e.tag(t, `["for review", "saved"]`)
	n, _ = count()
	assert.Zero(t, n, "a saved file is out of Needs you's count, with or without comments")
	assert.EqualValues(t, 2, rows()[0]["new_comments"], "but its row still says new comments (Saved, Artifacts)")

	assert.Nil(t, listAs(e.srv.URL)[0]["new_comments"], "a list that is not the Operator's own (an agent, a guest) never has it")
	e.tag(t, `["for review", "read"]`)
	delete(news, e.id) // the thread was opened
	n, _ = count()
	assert.Zero(t, n, "opened again: read")
	assert.Nil(t, rows()[0]["new_comments"])

	// #12026 (the Orchestrator's decision): a file the Operator already DECIDED (approved, or denied) comes back to Needs you as its own row when an agent replies in their thread, marked and counted once; an ignored or
	// saved one does not. The list answers the tag "new comments" with the rows that have news, whatever else they are tagged.
	e.tag(t, `["approved"]`)
	n, _ = count()
	assert.Zero(t, n, "an approved file is not in Needs you")
	news[e.id] = 1
	n, out = count()
	assert.Equal(t, 1, n, "an approved file the agent replied about comes back, once")
	items = needsYouItems(out)
	require.Len(t, items, 1)
	assert.Equal(t, "review:alpha:"+e.id, items[0]["id"])
	assert.EqualValues(t, 1, items[0]["new_comments"])
	// #12097 (Security's INFO): the page reads ONE list, the one tagged "for review", and it already holds the decided files that have news, so the page makes no second request per team
	forReview := func() []any {
		resp, err := http.Get(psrv.URL + "/api/board/alpha/artifacts?tag=for%20review")
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		got, _ := out["artifacts"].([]any)
		return got
	}
	assert.Len(t, forReview(), 1, "the approved file with news is in the for-review list")
	resp, err := http.Get(psrv.URL + "/api/board/alpha/artifacts?tag=new%20comments")
	require.NoError(t, err)
	var tagged map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&tagged))
	resp.Body.Close()
	require.Len(t, tagged["artifacts"], 1, "the list has the row for the tag new comments")
	e.tag(t, `["denied"]`)
	n, _ = count()
	assert.Equal(t, 1, n, "a denied one too")
	assert.Len(t, forReview(), 1)
	e.tag(t, `["ignored"]`)
	n, _ = count()
	assert.Zero(t, n, "an ignored file stays out: the Operator chose not to see it")
	assert.Empty(t, forReview(), "and out of the for-review list")
	e.tag(t, `["approved", "saved"]`)
	n, _ = count()
	assert.Zero(t, n, "a saved file is not counted")
	assert.Empty(t, forReview())
	e.tag(t, `["approved", "superseded"]`)
	n, _ = count()
	assert.Zero(t, n, "a file with a newer version is not the one to look at")
	assert.Empty(t, forReview())
	delete(news, e.id)
	e.tag(t, `["approved"]`)
	assert.Empty(t, forReview(), "an approved file with no news is not in the for-review list")
	resp, err = http.Get(psrv.URL + "/api/board/alpha/artifacts?tag=new%20comments")
	require.NoError(t, err)
	tagged = map[string]any{}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&tagged))
	resp.Body.Close()
	assert.Empty(t, tagged["artifacts"], "no news: no row for the tag")
	n, _ = count()
	assert.Zero(t, n, "and an approved file with no news is not in Needs you")

	// Security's SHOULD on a6b5440ae: a file the Operator asked changes of is the agent's turn, so it is not counted, unless an agent replied in the Operator's thread (that is news): whichever of this and #11985 lands first
	e.tag(t, `["for review", "changes requested"]`)
	n, _ = count()
	assert.Zero(t, n, "changes requested, no news: the agent's turn")
	news[e.id] = 1
	n, _ = count()
	assert.Equal(t, 1, n, "changes requested and the agent replied in the thread: it is back, once")
	delete(news, e.id)

	news["ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"] = 5
	n, _ = count()
	assert.Zero(t, n, "news on another file is not this file's")
}
