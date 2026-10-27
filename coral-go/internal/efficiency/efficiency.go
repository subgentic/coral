// Package efficiency computes the Analytics view's two efficiency measures (#8915): tokens per commit and the median time a task took (claim to done, review not counted), grouped by provider,
// model, thinking level, team, agent, branch or task. It is pure: the caller reads the rows (usage, commits, tasks) and this package groups and sums them, so every rule is testable on its own.
//
// What is attributed to what:
//   - A usage row has its own provider, model, thinking level and team, and belongs to a session (its agent). Its tokens are input + output, as the Spend read counts them.
//   - A commit belongs to the session that recorded it first, and has the provider, team and agent of that session and the branch it was recorded on. For a model or thinking-level group a commit
//     belongs to the model or level that spent most of its session's tokens in the range.
//   - A task has the provider, model, thinking level (the one recorded at its claim), team, agent and branch of the session that claimed it (the session recorded at the claim), and its own tokens and cost
//     (what the board stored when it was completed). Its time is the work: from the claim to the submission for review (or to completion when it had none), and the same for each round before it that a
//     rejection or send-back ended; review time is not counted. A commit belongs to at most one task: the latest-claimed of its session's tasks that was open when it was made.
//   - A task whose session is not known (none was recorded at its claim) or whose provider is not measured (Gemini writes no usage) is left out of BOTH measures: a measure over fewer tasks than exist
//     says which providers it cannot read (Unmeasured, and "unknown" for tasks of no known session), and the rest are not guessed.
//   - A figure nobody could answer (tokens per commit with no commit, a median with no task) is absent, never zero. Result.Median is the median task time, or the ratio of all tokens to all commits (the
//     "average" of the view's JSON).
package efficiency

import (
	"fmt"
	"sort"
	"strings"
)

// Metric names what is measured; Dim what it is grouped by.
const (
	TokensPerCommit = "tokens_per_commit"
	TaskTime        = "task_time"

	Provider = "provider"
	Model    = "model"
	Thinking = "thinking"
	Team     = "team"
	Agent    = "agent"
	Branch   = "branch"
	Task     = "task"

	// MinSample is how many commits or tasks a group needs before its figure is more than an anecdote (a group below it is marked, not hidden).
	MinSample = 10
	// NotRecorded labels the group of a dimension that older rows did not record (the thinking level before #8915, a model a CLI did not name).
	NotRecorded = "Not recorded"
)

var metrics = map[string]bool{TokensPerCommit: true, TaskTime: true}
var dims = []string{Provider, Model, Thinking, Team, Agent, Branch, Task}

// ValidMetric and ValidDim report whether a request parameter is one of the allowed values; Dims lists them for an error message.
func ValidMetric(m string) bool { return metrics[m] }
func ValidDim(d string) bool {
	for _, x := range dims {
		if x == d {
			return true
		}
	}
	return false
}
func Dims() string { return strings.Join(dims, ", ") }

// UsageRow is the tokens and cost of one session at one model and thinking level in the range.
type UsageRow struct {
	Session  string
	Provider string
	Team     string
	Model    string
	Thinking string
	Tokens   int64
	CostUSD  float64
}

// Commit is one commit, recorded first by Session on Branch.
type Commit struct {
	Hash    string
	Session string
	Branch  string
}

// Session is what is known of an agent's session: its labels and where its commits went.
type Session struct {
	ID       string
	Agent    string
	Provider string
	Team     string
	Branch   string // the session's most recent branch (what the By branch read attributes its tokens to)
}

// TaskRow is a finished task as the board stored it.
type TaskRow struct {
	ID       int64
	Title    string
	Team     string
	Agent    string // the agent that claimed it
	Provider string
	Model    string
	Thinking string // recorded at the claim; "" for every older one
	Branch   string
	// WorkSeconds is claim to the last submission for review (or completion); nil when the task has no claim time.
	WorkSeconds *float64
	SentBack    bool
	Tokens      int64
	CostUSD     float64
	// Commits are the commits of the claimer's session while the task was open (for the tokens-per-commit measure grouped by task).
	Commits int
}

// Input is everything one window needs.
type Input struct {
	Usage    []UsageRow
	Commits  []Commit
	Sessions map[string]Session
	Tasks    []TaskRow
	// Providers with usage rows to count; a commit or task of any other provider is left out and the provider is reported as unmeasured.
	Measured map[string]bool
	// Labels: team key to name.
	TeamLabels map[string]string
}

// Group is one bar of the view.
type Group struct {
	Key             string   `json:"key"`
	Label           string   `json:"label"`
	Provider        string   `json:"provider,omitempty"`
	Value           *float64 `json:"value,omitempty"`
	N               int      `json:"n"`
	Tokens          int64    `json:"tokens"`
	CostPerUnit     *float64 `json:"cost_usd_per_unit,omitempty"`
	SentBackShare   *float64 `json:"sent_back_share,omitempty"`
	LowSample       bool     `json:"low_sample,omitempty"`
	CostUSD         float64  `json:"-"`
	sentBack        int
	values          []float64
	providerCounter map[string]int
}

// Total is the sum over every group.
type Total struct {
	N       int     `json:"n"`
	Tokens  int64   `json:"tokens"`
	CostUSD float64 `json:"cost_usd"`
}

// Result is one window's answer.
type Result struct {
	Groups     []Group
	Total      Total
	Median     *float64 // the figure over everything in the window: the median task time, or all tokens per all commits (the JSON's "average")
	Unmeasured []string
}

// Compute answers metric grouped by dim over in. dim and metric must be valid.
func Compute(metric, dim string, in Input) (Result, error) {
	if !metrics[metric] || !ValidDim(dim) {
		return Result{}, fmt.Errorf("efficiency: metric %q or group_by %q is not known", metric, dim)
	}
	if metric == TokensPerCommit {
		return tokensPerCommit(dim, in), nil
	}
	return taskTime(dim, in), nil
}

func tokensPerCommit(dim string, in Input) Result {
	groups := map[string]*Group{}
	get := func(key string) *Group {
		g := groups[key]
		if g == nil {
			g = &Group{Key: key, providerCounter: map[string]int{}}
			groups[key] = g
		}
		return g
	}
	dominant := dominantBySession(in.Usage)
	unmeasured := map[string]bool{}
	var res Result
	for _, u := range in.Usage {
		if !in.Measured[u.Provider] {
			continue
		}
		var key string
		switch dim {
		case Provider:
			key = u.Provider
		case Model:
			key = u.Model
		case Thinking:
			key = u.Thinking
		case Team:
			key = u.Team
		case Agent:
			key = agentKey(in, u.Session)
		case Branch:
			key = in.Sessions[u.Session].Branch
		case Task:
			continue // a task's tokens are its own, below
		}
		g := get(key)
		g.Tokens += u.Tokens
		g.CostUSD += u.CostUSD
		g.providerCounter[u.Provider]++
		res.Total.Tokens += u.Tokens
		res.Total.CostUSD += u.CostUSD
	}
	if dim == Task {
		for _, t := range in.Tasks {
			if !in.Measured[t.Provider] {
				unmeasured[unmeasuredName(t.Provider)] = true
				continue
			}
			g := get(fmt.Sprint(t.ID))
			g.Label = fmt.Sprintf("#%d %s", t.ID, t.Title)
			g.Tokens += t.Tokens
			g.CostUSD += t.CostUSD
			g.N += t.Commits
			g.providerCounter[t.Provider]++
			res.Total.Tokens += t.Tokens
			res.Total.CostUSD += t.CostUSD
			res.Total.N += t.Commits
		}
	} else {
		for _, c := range in.Commits {
			s := in.Sessions[c.Session]
			if !in.Measured[s.Provider] {
				if s.Provider != "" {
					unmeasured[s.Provider] = true
				}
				continue
			}
			var key string
			switch dim {
			case Provider:
				key = s.Provider
			case Model:
				key = dominant[c.Session].model
			case Thinking:
				key = dominant[c.Session].thinking
			case Team:
				key = s.Team
			case Agent:
				key = agentKey(in, c.Session)
			case Branch:
				key = c.Branch
			}
			g := get(key)
			g.N++
			g.providerCounter[s.Provider]++
			res.Total.N++
		}
	}
	out := make([]Group, 0, len(groups))
	for _, g := range groups {
		g.Label = label(dim, g.Key, g.Label, in)
		g.Provider = providerOf(dim, g)
		if g.N > 0 && g.Tokens > 0 { // commits and no tokens: the session spent them before the range, so there is no figure (never 0)
			v := float64(g.Tokens) / float64(g.N)
			c := g.CostUSD / float64(g.N)
			g.Value, g.CostPerUnit = &v, &c
		}
		g.LowSample = g.N < MinSample
		out = append(out, *g)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Tokens != out[j].Tokens {
			return out[i].Tokens > out[j].Tokens
		}
		return out[i].Key < out[j].Key
	})
	res.Groups = out
	if res.Total.N > 0 && res.Total.Tokens > 0 {
		v := float64(res.Total.Tokens) / float64(res.Total.N)
		res.Median = &v
	}
	res.Unmeasured = sortedKeys(unmeasured)
	return res
}

func taskTime(dim string, in Input) Result {
	groups := map[string]*Group{}
	unmeasured := map[string]bool{}
	var res Result
	var all []float64
	for _, t := range in.Tasks {
		if !in.Measured[t.Provider] { // the same rule as tokens per commit: a provider Coral reads no usage of, or a task of no known session, is not counted
			unmeasured[unmeasuredName(t.Provider)] = true
			continue
		}
		key := ""
		switch dim {
		case Provider:
			key = t.Provider
		case Model:
			key = t.Model
		case Thinking:
			key = t.Thinking
		case Team:
			key = t.Team
		case Agent:
			key = t.Agent
		case Branch:
			key = t.Branch
		case Task:
			key = fmt.Sprint(t.ID)
		}
		g := groups[key]
		if g == nil {
			g = &Group{Key: key, providerCounter: map[string]int{}}
			if dim == Task {
				g.Label = fmt.Sprintf("#%d %s", t.ID, t.Title)
			}
			groups[key] = g
		}
		g.providerCounter[t.Provider]++
		if t.WorkSeconds == nil {
			continue // no claim time: the task is not a sample of how long work takes, and its tokens and cost are not counted against the tasks that are
		}
		g.Tokens += t.Tokens
		g.CostUSD += t.CostUSD
		res.Total.Tokens += t.Tokens
		res.Total.CostUSD += t.CostUSD
		g.N++
		g.values = append(g.values, *t.WorkSeconds)
		all = append(all, *t.WorkSeconds)
		if t.SentBack {
			g.sentBack++
		}
		res.Total.N++
	}
	out := make([]Group, 0, len(groups))
	for _, g := range groups {
		g.Label = label(dim, g.Key, g.Label, in)
		g.Provider = providerOf(dim, g)
		if g.N > 0 {
			v := median(g.values)
			c := g.CostUSD / float64(g.N)
			s := float64(g.sentBack) / float64(g.N)
			g.Value, g.CostPerUnit, g.SentBackShare = &v, &c, &s
		}
		g.LowSample = g.N < MinSample
		out = append(out, *g)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].N != out[j].N {
			return out[i].N > out[j].N
		}
		return out[i].Key < out[j].Key
	})
	res.Groups = out
	if len(all) > 0 {
		v := median(all)
		res.Median = &v
	}
	res.Unmeasured = sortedKeys(unmeasured)
	return res
}

type dominantPair struct{ model, thinking string }

// dominantBySession is, for each session, the model and the thinking level that spent most of its tokens in the window (ties: the smaller name): the group a commit of the session belongs to.
func dominantBySession(rows []UsageRow) map[string]dominantPair {
	models := map[string]map[string]int64{}
	levels := map[string]map[string]int64{}
	for _, r := range rows {
		if models[r.Session] == nil {
			models[r.Session], levels[r.Session] = map[string]int64{}, map[string]int64{}
		}
		models[r.Session][r.Model] += r.Tokens
		levels[r.Session][r.Thinking] += r.Tokens
	}
	pick := func(m map[string]int64) string { // a named model or level beats "not recorded", whatever its tokens
		best, bestT := "", int64(-1)
		for k, v := range m {
			if k == "" {
				continue
			}
			if v > bestT || (v == bestT && k < best) {
				best, bestT = k, v
			}
		}
		return best
	}
	out := map[string]dominantPair{}
	for s := range models {
		out[s] = dominantPair{model: pick(models[s]), thinking: pick(levels[s])}
	}
	return out
}

func agentKey(in Input, session string) string {
	if s, ok := in.Sessions[session]; ok && s.Agent != "" {
		return s.Agent
	}
	return session
}

func label(dim, key, given string, in Input) string {
	if given != "" {
		return given
	}
	switch dim {
	case Model, Thinking:
		if key == "" {
			return NotRecorded
		}
	case Branch:
		if key == "" {
			return "No branch"
		}
	case Team:
		if l := in.TeamLabels[key]; l != "" {
			return l
		}
		if key == "" {
			return "No team"
		}
	case Provider:
		return ProviderLabel(key)
	case Agent:
		if key == "" {
			return "Unknown agent"
		}
	}
	return key
}

// Unknown names, in Unmeasured, the tasks that are left out because no session was recorded at their claim, so no provider is known.
const Unknown = "unknown"

func unmeasuredName(provider string) string {
	if provider == "" {
		return Unknown
	}
	return provider
}

// ProviderLabel is a provider's name as the view shows it.
func ProviderLabel(p string) string {
	switch p {
	case "claude":
		return "Claude"
	case "codex":
		return "Codex"
	case "gemini":
		return "Gemini"
	case "pi":
		return "Pi"
	case "agy":
		return "Antigravity"
	case Unknown:
		return "Provider not recorded"
	}
	return p
}

// providerOf is the provider a bar is coloured by: set for the provider, model and agent groups when the group's rows all name one.
func providerOf(dim string, g *Group) string {
	switch dim {
	case Provider:
		return g.Key
	case Model, Agent:
		if len(g.providerCounter) == 1 {
			for p := range g.providerCounter {
				return p
			}
		}
	}
	return ""
}

func median(v []float64) float64 {
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}

func sortedKeys(m map[string]bool) []string {
	out := []string{}
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// DominantModels is, for each session, the model that spent most of its tokens in the rows (ties: the smaller name); a session whose rows name no model has none. It is the model a session's commits and
// tasks are attributed to.
func DominantModels(rows []UsageRow) map[string]string {
	out := map[string]string{}
	for s, p := range dominantBySession(rows) {
		if p.model != "" {
			out[s] = p.model
		}
	}
	return out
}
