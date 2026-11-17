package board

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSearchTermsAreWordsAndQuotedPhrases(t *testing.T) {
	require.Equal(t, []string{"staging", "certificate"}, SearchTerms("Staging  certificate"))
	require.Equal(t, []string{"renewal", "tls certificate"}, SearchTerms(`renewal "TLS certificate"`))
	require.Equal(t, []string{"port 8443"}, SearchTerms(`"port 8443"`))
	require.Equal(t, []string{"a"}, SearchTerms("a a A"))
	require.Equal(t, []string{"abc"}, SearchTerms(`"abc`)) // an unclosed quote is read to its end
	require.Empty(t, SearchTerms(`"`), "a lone quote mark asks for nothing")
}

// A natural question has its words in any order (#19423, problem 1): the tasks and goals that hold every word match, each word in any field.
func TestSearchWorkMatchesEveryWordInAnyOrderAndAnyField(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	g, err := s.CreateGoal(ctx, "alpha", GoalInput{Title: "Billing export", Outcome: "customers export invoices every month", DoneWhen: "the export runs", CreatedBy: "op"})
	require.NoError(t, err)
	gid := g.ID
	tk, err := s.CreateTaskWithOpts(ctx, "alpha", "Fix expired certificate", "The deploy of the staging cluster failed because the TLS certificate expired.", "high", "orch", &CreateTaskOpts{GoalID: &gid})
	require.NoError(t, err)
	other, err := s.CreateTask(ctx, "alpha", "Rotate keys", "unrelated staging work", "low", "orch")
	require.NoError(t, err)

	find := func(text string) ([]int64, []int64) {
		hits, _, err := s.SearchWork(ctx, WorkQuery{Board: "alpha", Text: text, Limit: 20})
		require.NoError(t, err, text)
		return hitIDs(hits, "task"), hitIDs(hits, "goal")
	}
	for _, text := range []string{"certificate staging", "staging certificate", "STAGING   Certificate expired", "deploy cluster tls"} { // title and body, either order
		task, goal := find(text)
		require.Equal(t, []int64{tk.ID}, task, text)
		require.Empty(t, goal, text)
	}
	task, _ := find("staging")
	require.ElementsMatch(t, []int64{tk.ID, other.ID}, task, "one word still finds each task that has it")
	task, _ = find("staging billing")
	require.Empty(t, task, "a word that is nowhere in the task is no match")
	_, goal := find("invoices month export")
	require.Equal(t, []int64{g.ID}, goal, "the words of a goal's outcome, out of order")
	task, _ = find(`"cluster staging"`)
	require.Empty(t, task, "a quoted phrase is still one run of text")
	task, _ = find(`"staging cluster failed" tls`)
	require.Equal(t, []int64{tk.ID}, task, "a quoted phrase and a word")
}

// The hits that hold the words together, and in the title, come first; one word keeps the newest-first order it had.
func TestSearchWorkRanksTheTermsStandingTogetherFirst(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	apart, err := s.CreateTask(ctx, "alpha", "Notes", "the certificate is old. Later the staging box was rebuilt.", "low", "orch")
	require.NoError(t, err)
	together, err := s.CreateTask(ctx, "alpha", "Notes 2", "the staging certificate is old", "low", "orch")
	require.NoError(t, err)
	titled, err := s.CreateTask(ctx, "alpha", "Staging certificate", "x", "low", "orch")
	require.NoError(t, err)
	newest, err := s.CreateTask(ctx, "alpha", "Latest", "the certificate of the staging box", "low", "orch")
	require.NoError(t, err)

	hits, _, err := s.SearchWork(ctx, WorkQuery{Board: "alpha", Text: "staging certificate", Sources: []string{"tasks"}, Limit: 20})
	require.NoError(t, err)
	require.Equal(t, []int64{titled.ID, together.ID, newest.ID, apart.ID}, hitIDs(hits, "task"), "in the title and together, together, then the rest newest first")

	hits, _, err = s.SearchWork(ctx, WorkQuery{Board: "alpha", Text: "certificate", Sources: []string{"tasks"}, Limit: 20})
	require.NoError(t, err)
	require.Equal(t, []int64{newest.ID, titled.ID, together.ID, apart.ID}, hitIDs(hits, "task"), "one word: newest first, as before")
}

// The snippet is cut around the match, so the answer is in it (#19423, problem 5), for words as for a phrase.
func TestWorkSnippetIsCenteredOnTheWordsAskedFor(t *testing.T) {
	filler := strings.Repeat("filler text ", 40)
	body := filler + "the answer is port 8443 on the ingress. " + filler
	for _, text := range []string{"8443", "ingress 8443", "port 8443", `"port 8443"`} {
		sn := WorkSnippet(text, "A title", body)
		require.Contains(t, sn, "8443", text)
		require.LessOrEqual(t, len([]rune(sn)), workSnippetWidth+2, text)
	}
	// the field with the most of the words is the one shown
	sn := WorkSnippet("alpha beta", "alpha only here", filler+"beta first then alpha later")
	require.Contains(t, sn, "beta first")
	// on a tie the first field listed wins: a task lists its body before its title
	require.Equal(t, "body has alpha and beta", WorkSnippet("alpha beta", "body has alpha and beta", "Title alpha beta"))
}

func TestQueryMessagesAllWordsAndWithoutSystemPosts(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	post := func(who, text string) int64 {
		m, err := s.PostMessage(ctx, "alpha", who, text, nil)
		require.NoError(t, err)
		return m.ID
	}
	a := post("Dana", "we decided that the staging certificate gets renewed on Friday")
	_ = post("Dana", "the certificate for production is fine")
	sys, err := s.PostSystemMessage(ctx, "alpha", "Coral Task Queue", "[New Task #2] Fix the staging certificate", nil)
	require.NoError(t, err)

	ids := func(p MessageQueryParams, noSystem bool) []int64 {
		q, err := ParseMessageQuery(p)
		require.NoError(t, err)
		q.Project, q.NoSystem = "alpha", noSystem
		res, err := s.QueryMessages(ctx, q)
		require.NoError(t, err)
		var out []int64
		for _, m := range res.Messages {
			out = append(out, m.ID)
		}
		return out
	}
	words := func(text string) MessageQueryParams {
		return MessageQueryParams{Q: []string{text}, AllWords: []string{"1"}}
	}
	require.ElementsMatch(t, []int64{a, sys.ID}, ids(words("certificate staging"), false), "words in any order")
	require.ElementsMatch(t, []int64{a, sys.ID}, ids(words("staging certificate"), false))
	require.Equal(t, []int64{a}, ids(words("renewed staging friday"), false))
	require.Empty(t, ids(words("staging billing"), false), "a missing word is no match")
	require.Equal(t, []int64{a}, ids(words("staging certificate"), true), "Coral's own posts left out")
	// without AllWords the text is one run, as the dashboard's message search has always read it
	require.Empty(t, ids(MessageQueryParams{Q: []string{"certificate staging"}}, false))
	require.Equal(t, []int64{a}, ids(MessageQueryParams{Q: []string{"staging certificate gets"}}, false))
	// a quoted phrase is one term
	require.Equal(t, []int64{a}, ids(words(`"staging certificate" renewed`), true))
}
