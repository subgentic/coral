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

// #11998 (Beta pass 2): a goal's design doc showed twice in Needs you, once as a question with a raw coral:// link and once as the file. A question that only links a file the same team lists as a file for review is
// that file, not a second item, and the count agrees; a question with words of its own that mentions the file stays, and so does one that links a file not listed.
func TestNeedsYouListsAFileOnceNotAgainAsAQuestionThatOnlyLinksIt(t *testing.T) {
	e := newReviewEnv(t, true)
	e.tag(t, `["for review"]`)
	ctx := context.Background()
	ask := func(text string) {
		q, err := e.h.bs.PostMessage(ctx, "alpha", "Alice", "@Operator "+text, nil)
		require.NoError(t, err)
		require.NoError(t, e.h.bs.RecordAsk(ctx, "alpha", q, []string{"Operator"}))
	}
	read := func() (int, []map[string]any) {
		code, out := readNeedsYou(t, e.h, "", asPerson)
		require.Equal(t, http.StatusOK, code, out)
		return int(out["count"].(float64)), needsYouItems(out)
	}
	n, items := read()
	require.Equal(t, 1, n, "the file alone")
	require.Equal(t, "review", items[0]["kind"])
	ask("The design doc: coral://artifacts/" + e.id)
	n, items = read()
	assert.Equal(t, 1, n, "a message that only links the file is not a second item")
	require.Len(t, items, 1)
	assert.Equal(t, "review", items[0]["kind"], "the file is the item")
	ask("Should we ship this on Friday or wait for the next release? Please read coral://artifacts/" + e.id + " first.")
	n, _ = read()
	assert.Equal(t, 2, n, "a question with words of its own stays")
	ask("The other doc: coral://artifacts/" + strings.Repeat("ab", 32))
	n, _ = read()
	assert.Equal(t, 3, n, "a link to a file the team does not list for review is a question as before")
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

// #12096 (Beta Tester): every design-doc version adds a message ("design doc v5 is in your Inbox: coral://..."), and the older ones stayed after the doc was approved, reaching 9+ on the badge. A message that is only
// links to files the team has had in a review is read once those files are opened, decided or replaced; a link to a file never in a review stays a question.
func TestAMessageThatOnlyLinksReviewedFilesIsReadOnceTheyAreOpenedDecidedOrReplaced(t *testing.T) {
	e := newReviewEnv(t, true)
	ctx := context.Background()
	post := func(text string) {
		q, err := e.h.bs.PostMessage(ctx, "alpha", "Alice", "@Operator "+text, nil)
		require.NoError(t, err)
		require.NoError(t, e.h.bs.RecordAsk(ctx, "alpha", q, []string{"Operator"}))
	}
	counts := func() (int, int) {
		code, out := readNeedsYou(t, e.h, "", asPerson)
		require.Equal(t, http.StatusOK, code, out)
		acode, rows, _ := readOperatorAsks(t, e.h, asPerson)
		require.Equal(t, http.StatusOK, acode)
		return int(out["count"].(float64)), len(rows)
	}
	post("design doc v2 is in your Inbox: coral://artifacts/" + e.id)
	post("a report never in a review: coral://artifacts/" + strings.Repeat("cd", 32))
	for _, tags := range []string{`["for review"]`, `["for review","read"]`, `["approved"]`, `["changes requested"]`, `["superseded"]`, `["ignored"]`} {
		e.tag(t, tags)
		n, rows := counts()
		assert.Equal(t, 1, rows, "%s: the message about the reviewed file is not a row, the one about an unreviewed file is", tags)
		want := 1
		if tags == `["for review"]` {
			want = 2 // the file itself is the one item, plus the unreviewed link's question
		}
		assert.Equal(t, want, n, "%s: Needs you count", tags)
	}
	e.tag(t, `[]`)
	n, rows := counts()
	assert.Equal(t, 2, rows, "a file with no review tag: its message is a question as before")
	assert.Equal(t, 2, n)
}

// Security's two SHOULDs on #12096: a message with answer buttons is never hidden (the Operator can only answer it from its row), and one whose other text asks something (a question mark, or a word an ask uses) is a
// question, not a pointer to a file.
func TestAMessageWithButtonsOrAQuestionAroundTheLinkIsNeverHiddenAsAFileLink(t *testing.T) {
	e := newReviewEnv(t, true)
	ctx := context.Background()
	e.tag(t, `["approved"]`) // the file was reviewed and decided: a bare link message to it is read
	post := func(text string) *board.Message {
		q, err := e.h.bs.PostMessage(ctx, "alpha", "Alice", "@Operator "+text, nil)
		require.NoError(t, err)
		require.NoError(t, e.h.bs.RecordAsk(ctx, "alpha", q, []string{"Operator"}))
		return q
	}
	counts := func() (int, int) {
		code, out := readNeedsYou(t, e.h, "", asPerson)
		require.Equal(t, http.StatusOK, code, out)
		acode, rows, _ := readOperatorAsks(t, e.h, asPerson)
		require.Equal(t, http.StatusOK, acode)
		return int(out["count"].(float64)), len(rows)
	}
	link := "coral://artifacts/" + e.id
	post("design doc v2 is in your Inbox: " + link)
	n, rows := counts()
	assert.Equal(t, 0, n, "a bare link to a decided file is read")
	assert.Equal(t, 0, rows)
	withButtons := post("Yes or no: " + link)
	require.NoError(t, e.h.bs.RecordAskButtons(ctx, "alpha", withButtons.ID, []board.AskButton{{Label: "Yes", Action: "reply"}, {Label: "No", Action: "reply"}}, time.Now()))
	n, rows = counts()
	assert.Equal(t, 1, n, "a question with answer buttons stays, though it only links a decided file")
	assert.Equal(t, 1, rows)
	post("Deploy to prod now? " + link)
	n, rows = counts()
	assert.Equal(t, 2, n, "a short question with a question mark stays")
	assert.Equal(t, 2, rows)
	post("please approve " + link)
	n, rows = counts()
	assert.Equal(t, 3, n, "an ask word keeps it a question")
	assert.Equal(t, 3, rows)
}
