package efficiency

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func f(v float64) *float64 { return &v }

func fixture() Input {
	return Input{
		Measured:   map[string]bool{"claude": true, "codex": true},
		TeamLabels: map[string]string{"alpha": "Alpha team"},
		Sessions: map[string]Session{
			"s1": {ID: "s1", Agent: "Backend Dev", Provider: "claude", Team: "alpha", Branch: "main"},
			"s2": {ID: "s2", Agent: "Frontend Dev", Provider: "codex", Team: "alpha", Branch: "ui"},
			"s3": {ID: "s3", Agent: "Gem", Provider: "gemini", Team: "alpha", Branch: "main"},
			"s4": {ID: "s4", Agent: "Quiet", Provider: "claude", Team: "beta", Branch: "x"},
		},
		Usage: []UsageRow{
			{Session: "s1", Provider: "claude", Team: "alpha", Model: "opus", Thinking: "high", Tokens: 600, CostUSD: 6},
			{Session: "s1", Provider: "claude", Team: "alpha", Model: "sonnet", Thinking: "", Tokens: 400, CostUSD: 1},
			{Session: "s2", Provider: "codex", Team: "alpha", Model: "gpt", Thinking: "low", Tokens: 1000, CostUSD: 2},
			{Session: "s4", Provider: "claude", Team: "beta", Model: "opus", Thinking: "high", Tokens: 500, CostUSD: 5},
		},
		Commits: []Commit{{"c1", "s1", "main"}, {"c2", "s1", "feature"}, {"c3", "s2", "ui"}, {"c4", "s2", "ui"}, {"c5", "s3", "main"}},
	}
}

func groupsByKey(r Result) map[string]Group {
	out := map[string]Group{}
	for _, g := range r.Groups {
		out[g.Key] = g
	}
	return out
}

func TestTokensPerCommitByEveryDimension(t *testing.T) {
	in := fixture()
	for _, tc := range []struct {
		dim  string
		want map[string][2]float64 // key: tokens, commits
	}{
		{Provider, map[string][2]float64{"claude": {1500, 2}, "codex": {1000, 2}}},
		{Team, map[string][2]float64{"alpha": {2000, 4}, "beta": {500, 0}}},
		{Agent, map[string][2]float64{"Backend Dev": {1000, 2}, "Frontend Dev": {1000, 2}, "Quiet": {500, 0}}},
		{Branch, map[string][2]float64{"main": {1500, 1}, "feature": {0, 1}, "ui": {1000, 2}}}, // tokens by the session's most recent branch, commits by their own
		{Model, map[string][2]float64{"opus": {1100, 2}, "sonnet": {400, 0}, "gpt": {1000, 2}}},
		{Thinking, map[string][2]float64{"high": {1100, 2}, "": {400, 0}, "low": {1000, 2}}},
	} {
		r, err := Compute(TokensPerCommit, tc.dim, in)
		require.NoError(t, err, tc.dim)
		got := groupsByKey(r)
		for key, tw := range tc.want {
			g, ok := got[key]
			require.True(t, ok, "%s: group %q", tc.dim, key)
			if tc.dim != Branch {
				assert.EqualValues(t, tw[0], g.Tokens, "%s %q tokens", tc.dim, key)
			}
			assert.EqualValues(t, tw[1], g.N, "%s %q commits", tc.dim, key)
		}
	}
}

func TestAFigureNobodyCouldAnswerIsAbsentNeverZero(t *testing.T) {
	r, err := Compute(TokensPerCommit, Team, fixture())
	require.NoError(t, err)
	beta := groupsByKey(r)["beta"]
	assert.Equal(t, 0, beta.N)
	assert.Nil(t, beta.Value, "tokens and no commit: no value")
	assert.Nil(t, beta.CostPerUnit)
	alpha := groupsByKey(r)["alpha"]
	require.NotNil(t, alpha.Value)
	assert.InDelta(t, 500, *alpha.Value, 0.001)
	require.NotNil(t, alpha.CostPerUnit)
	assert.InDelta(t, 2.25, *alpha.CostPerUnit, 0.001)
	// commits and no tokens at all (a session with no rows in the range): no value, not zero
	in := fixture()
	in.Usage = nil
	r, _ = Compute(TokensPerCommit, Provider, in)
	for _, g := range r.Groups {
		assert.Nil(t, g.Value, g.Key)
	}
	assert.Nil(t, r.Median)
}

func TestAProviderWithNoUsageRowsIsLeftOutAndSaidSo(t *testing.T) {
	r, err := Compute(TokensPerCommit, Provider, fixture())
	require.NoError(t, err)
	assert.Equal(t, []string{"gemini"}, r.Unmeasured)
	_, ok := groupsByKey(r)["gemini"]
	assert.False(t, ok, "its commit is not counted")
	assert.Equal(t, 4, r.Total.N)
	in := fixture()
	in.Commits = in.Commits[:4]
	r, _ = Compute(TokensPerCommit, Provider, in)
	assert.Equal(t, []string{}, r.Unmeasured, "present and empty when nothing is left out")
}

func TestTheAverageAndTheTotalAreOverEverything(t *testing.T) {
	r, _ := Compute(TokensPerCommit, Model, fixture())
	require.NotNil(t, r.Median)
	assert.InDelta(t, 2500.0/4, *r.Median, 0.001)
	assert.EqualValues(t, 2500, r.Total.Tokens)
	assert.InDelta(t, 14.0, r.Total.CostUSD, 0.001)
}

func TestLabelsAndTheSampleMark(t *testing.T) {
	r, _ := Compute(TokensPerCommit, Thinking, fixture())
	g := groupsByKey(r)
	assert.Equal(t, NotRecorded, g[""].Label)
	assert.True(t, g["high"].LowSample, "two commits is below the minimum sample")
	r, _ = Compute(TokensPerCommit, Team, fixture())
	assert.Equal(t, "Alpha team", groupsByKey(r)["alpha"].Label)
	r, _ = Compute(TokensPerCommit, Provider, fixture())
	assert.Equal(t, "Claude", groupsByKey(r)["claude"].Label)
	assert.Equal(t, "claude", groupsByKey(r)["claude"].Provider)
	r, _ = Compute(TokensPerCommit, Model, fixture())
	assert.Equal(t, "claude", groupsByKey(r)["opus"].Provider, "a model whose rows all name one provider carries it")
	r, _ = Compute(TokensPerCommit, Team, fixture())
	assert.Equal(t, "", groupsByKey(r)["alpha"].Provider, "a team spans providers")
}

func taskFixture() Input {
	in := fixture()
	in.Tasks = []TaskRow{
		{ID: 1, Title: "a", Team: "alpha", Agent: "Backend Dev", Provider: "claude", Model: "opus", Thinking: "high", Branch: "main", WorkSeconds: f(100), Tokens: 10, CostUSD: 1},
		{ID: 2, Title: "b", Team: "alpha", Agent: "Backend Dev", Provider: "claude", Model: "opus", Thinking: "high", Branch: "main", WorkSeconds: f(300), SentBack: true, Tokens: 30, CostUSD: 3},
		{ID: 3, Title: "c", Team: "alpha", Agent: "Backend Dev", Provider: "claude", Model: "opus", Thinking: "high", Branch: "main", WorkSeconds: f(200), Tokens: 20, CostUSD: 2},
		{ID: 4, Title: "d", Team: "beta", Agent: "Frontend Dev", Provider: "codex", Model: "gpt", Thinking: "", Branch: "ui", WorkSeconds: f(50), Tokens: 5, CostUSD: 0.5},
		{ID: 5, Title: "no claim", Team: "beta", Agent: "Frontend Dev", Provider: "codex", Model: "gpt", Thinking: "", Branch: "ui", WorkSeconds: nil, Tokens: 1, CostUSD: 0.1},
		{ID: 6, Title: "gem", Team: "alpha", Agent: "Gem", Provider: "gemini", WorkSeconds: f(10)},
	}
	return in
}

func TestTaskTimeIsTheMedianAndTheSentBackShare(t *testing.T) {
	r, err := Compute(TaskTime, Agent, taskFixture())
	require.NoError(t, err)
	g := groupsByKey(r)
	be := g["Backend Dev"]
	require.NotNil(t, be.Value)
	assert.InDelta(t, 200, *be.Value, 0.001, "the median of 100, 300, 200")
	assert.Equal(t, 3, be.N)
	require.NotNil(t, be.SentBackShare)
	assert.InDelta(t, 1.0/3, *be.SentBackShare, 0.001)
	require.NotNil(t, be.CostPerUnit)
	assert.InDelta(t, 2.0, *be.CostPerUnit, 0.001)
	fe := g["Frontend Dev"]
	assert.Equal(t, 1, fe.N, "a task with no claim time is not a sample")
	assert.EqualValues(t, 5, fe.Tokens, "and its tokens are not counted against the timed ones (#8968)")
	require.NotNil(t, r.Median)
	assert.InDelta(t, 150, *r.Median, 0.001, "median of 100, 300, 200, 50: the Gemini task is in neither measure")
}

func TestTaskTimeByTaskAndByThinkingLevel(t *testing.T) {
	r, _ := Compute(TaskTime, Task, taskFixture())
	g := groupsByKey(r)
	assert.Equal(t, "#2 b", g["2"].Label)
	require.NotNil(t, g["2"].SentBackShare)
	assert.InDelta(t, 1.0, *g["2"].SentBackShare, 0.001)
	assert.Nil(t, g["5"].Value, "no claim time: no value")
	r, _ = Compute(TaskTime, Thinking, taskFixture())
	g = groupsByKey(r)
	assert.Equal(t, NotRecorded, g[""].Label)
	assert.Equal(t, 3, g["high"].N)
	assert.Equal(t, []string{"gemini"}, r.Unmeasured)
}

func TestTokensPerCommitByTaskUsesTheTasksOwnTokensAndCommits(t *testing.T) {
	in := taskFixture()
	in.Tasks[0].Commits, in.Tasks[1].Commits = 2, 1
	r, err := Compute(TokensPerCommit, Task, in)
	require.NoError(t, err)
	g := groupsByKey(r)
	require.NotNil(t, g["1"].Value)
	assert.InDelta(t, 5, *g["1"].Value, 0.001)
	assert.Nil(t, g["3"].Value, "no commit")
}

func TestBadParametersAreRefused(t *testing.T) {
	_, err := Compute("speed", Team, Input{})
	assert.Error(t, err)
	_, err = Compute(TaskTime, "shoe", Input{})
	assert.Error(t, err)
	assert.True(t, ValidDim(Branch) && !ValidDim("") && ValidMetric(TaskTime) && !ValidMetric(""))
}

func TestMedianOfAnEvenCount(t *testing.T) {
	assert.InDelta(t, 2.5, median([]float64{4, 1, 2, 3}), 0.0001)
	assert.InDelta(t, 3, median([]float64{3}), 0.0001)
}

func TestUsageOfAnUnmeasuredProviderIsNotCounted(t *testing.T) {
	in := fixture()
	in.Usage = append(in.Usage, UsageRow{Session: "s3", Provider: "gemini", Team: "alpha", Model: "g", Tokens: 12345, CostUSD: 9})
	r, err := Compute(TokensPerCommit, Provider, in)
	require.NoError(t, err)
	_, ok := groupsByKey(r)["gemini"]
	assert.False(t, ok)
	assert.EqualValues(t, 2500, r.Total.Tokens)
}

// #8968 (6): a task with no claim time counts for nothing in a task-time group: not its tokens, not its cost.
func TestTaskTimeTokensAndCostAreOfTheTimedTasksOnly(t *testing.T) {
	sec := 600.0
	in := Input{Measured: map[string]bool{"claude": true}, Tasks: []TaskRow{
		{ID: 1, Team: "a", Provider: "claude", Tokens: 100, CostUSD: 1, WorkSeconds: &sec},
		{ID: 2, Team: "a", Provider: "claude", Tokens: 900, CostUSD: 9}, // never claimed: no time
	}}
	r, err := Compute(TaskTime, Team, in)
	require.NoError(t, err)
	require.Len(t, r.Groups, 1)
	g := r.Groups[0]
	assert.Equal(t, 1, g.N)
	assert.EqualValues(t, 100, g.Tokens)
	require.NotNil(t, g.CostPerUnit)
	assert.InDelta(t, 1, *g.CostPerUnit, 1e-9, "the cost of the one timed task over that one task")
	assert.EqualValues(t, 100, r.Total.Tokens)
}

// #8968 (3): the same rule in both measures.
func TestBothMeasuresLeaveOutUnmeasuredAndUnknownProviders(t *testing.T) {
	sec := 60.0
	in := Input{Measured: map[string]bool{"claude": true}, Tasks: []TaskRow{
		{ID: 1, Provider: "claude", WorkSeconds: &sec, Commits: 1, Tokens: 10},
		{ID: 2, Provider: "gemini", WorkSeconds: &sec, Commits: 1, Tokens: 10},
		{ID: 3, Provider: "", WorkSeconds: &sec, Commits: 1, Tokens: 10},
	}}
	for _, m := range []string{TaskTime, TokensPerCommit} {
		r, err := Compute(m, Task, in)
		require.NoError(t, err)
		assert.Len(t, r.Groups, 1, m)
		assert.Equal(t, []string{"gemini", Unknown}, r.Unmeasured, m, "a task of no known session is named too (#8999)")
	}
}

// #8968 (14, 13): one dominant-model rule, a named model beats "not recorded", and an even median is not rounded.
func TestDominantModelsPreferANamedModelAndTheMedianIsExact(t *testing.T) {
	rows := []UsageRow{{Session: "s", Model: "", Tokens: 900}, {Session: "s", Model: "opus", Tokens: 100}, {Session: "t", Model: "", Tokens: 5}}
	m := DominantModels(rows)
	assert.Equal(t, "opus", m["s"])
	assert.NotContains(t, m, "t", "no model named: none")
	assert.InDelta(t, 1.005, median([]float64{1, 1.01}), 1e-12)
}
