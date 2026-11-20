package board

import (
	"fmt"
	"sort"
	"strings"
)

// RuleRoute is what every rule of the health check shares (#20136, the Operator's call: "make it generic, routed by agent"): To is the member the rule's line also goes to ("" leaves it to the rule's own recipient,
// the check's recipient or the team's Orchestrator), and Text is how much the line says, chosen from Coral's own templates (never text a caller writes: a free-text setting is an injection route into every
// agent's prompt).
type RuleRoute struct {
	To   string `json:"to,omitempty"`
	Text string `json:"text,omitempty"`
}

// The text levels of a rule's line. "" is TextNormal.
const (
	TextShort  = "short"
	TextNormal = "normal"
	TextLong   = "long"
)

// TextLevelValid says a text level is one Coral has a template for ("" is the default).
func TextLevelValid(t string) bool {
	return t == "" || t == TextShort || t == TextNormal || t == TextLong
}

// Level is the rule's text level, TextNormal when none is set.
func (r RuleRoute) Level() string {
	if r.Text == TextShort || r.Text == TextLong {
		return r.Text
	}
	return TextNormal
}

// Pick returns the template for the rule's level.
func (r RuleRoute) Pick(short, normal, long string) string {
	switch r.Level() {
	case TextShort:
		return short
	case TextLong:
		return long
	}
	return normal
}

// Member is who the rule's line also goes to: To, else the older Nudge field where the rule has one.
func (r RuleRoute) Member(nudge string) string {
	if t := strings.TrimSpace(r.To); t != "" {
		return t
	}
	return strings.TrimSpace(nudge)
}

func (r RuleRoute) problem(name string) string {
	if !TextLevelValid(r.Text) {
		return fmt.Sprintf("%s.text: %q is not short, normal or long", name, OneLine(r.Text))
	}
	return ""
}

// HealthOffBooks: how long after a task completes a post still counts as made on it, and how many off-the-books lines one check says.
type HealthOffBooks struct {
	PostGraceMin int `json:"post_grace_min"`
	MaxLines     int `json:"max_lines"`
}

// HealthPoolReview: the line for a review that has waited in the board's pool for AfterMin.
type HealthPoolReview struct {
	RuleRoute
	On       bool `json:"on"`
	AfterMin int  `json:"after_min"`
}

// HealthWaitEscalate: how long an agent waits on someone before that someone is told, once.
type HealthWaitEscalate struct {
	AfterMin int `json:"after_min"`
}

// The defaults of the settings that were fixed numbers.
const (
	OffBooksPostGraceDefault = 2
	OffBooksMaxLinesDefault  = 5
	PoolReviewAfterDefault   = 15
	WaitEscalateAfterDefault = 10
	UnownedMaxListDefault    = 8
)

func pickInt(v, def, lo, hi int) int { // 0: a body that does not carry the setting means the default
	if v == 0 {
		return def
	}
	return min(max(v, lo), hi)
}

// ruleRoutes is every rule's route, by its setting name, for the clamp, the checks and the key list.
func (h *HealthSettings) ruleRoutes() map[string]*RuleRoute {
	return map[string]*RuleRoute{
		"auto_delegate": &h.AutoDelegate.RuleRoute, "claim_nudge": &h.ClaimNudge.RuleRoute, "status_nudge": &h.StatusNudge.RuleRoute,
		"mention_renudge": &h.MentionRenudge.RuleRoute, "held_notice": &h.HeldNotice.RuleRoute, "busy_no_task": &h.BusyNoTask.RuleRoute,
		"post_no_task": &h.PostNoTask.RuleRoute, "upload_no_task": &h.UploadNoTask.RuleRoute, "goal_size": &h.GoalSize.RuleRoute,
		"ask_reminder": &h.AskReminder.RuleRoute, "deviations": &h.Deviations.RuleRoute, "landing": &h.Landing.RuleRoute,
		"release": &h.Release.RuleRoute, "goals_ready": &h.GoalsReady.RuleRoute, "unowned_tasks": &h.UnownedTasks.RuleRoute,
		"pool_review": &h.PoolReview.RuleRoute,
	}
}

// clampRoutes trims every To and turns a text level that is none of Coral's into the default.
func (h *HealthSettings) clampRoutes() {
	for _, r := range h.ruleRoutes() {
		r.To = strings.TrimSpace(r.To)
		if !TextLevelValid(r.Text) {
			r.Text = ""
		}
	}
}

// RouteProblems is what is wrong with the routes a user saves, in words: a text level that is none of Coral's. (That each To is a member of the team, and not the Operator, is the route's check: it needs the
// team's members.) named is the set of rule names the body carried; a rule it did not carry is not checked.
func (h HealthSettings) RouteProblems(named map[string]bool) string {
	names := make([]string, 0, len(h.ruleRoutes()))
	routes := h.ruleRoutes()
	for n := range routes {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if named[n] {
			if msg := routes[n].problem(n); msg != "" {
				return msg
			}
		}
	}
	return ""
}

// RouteMembers is each rule's To (and the older Nudge fields), by the key the setting is saved under, for the route to check that each is a member of the team.
func (h HealthSettings) RouteMembers() map[string]string {
	out := map[string]string{}
	for n, r := range h.ruleRoutes() {
		if t := strings.TrimSpace(r.To); t != "" {
			out[n+".to"] = t
		}
	}
	for n, t := range map[string]string{"landing.nudge": h.Landing.Nudge, "release.nudge": h.Release.Nudge, "goals_ready.nudge": h.GoalsReady.Nudge, "unowned_tasks.nudge": h.UnownedTasks.Nudge} {
		if t = strings.TrimSpace(t); t != "" {
			out[n] = t
		}
	}
	return out
}

// routeWired says which rules read their To and their Text in this build (#20136): a setting a rule does not read is refused when saved and shown as unused, never accepted and ignored.
var routeWired = map[string][2]bool{ // {to, text}
	"landing": {true, false}, "release": {true, false}, "unowned_tasks": {true, true}, "goal_size": {true, true},
	"busy_no_task": {true, true}, "post_no_task": {true, false}, "upload_no_task": {true, false}, "pool_review": {false, true},
}

// RouteWired reports whether the rule reads its recipient (to) and its text level (text).
func RouteWired(rule string) (to, text bool) {
	w := routeWired[rule]
	return w[0], w[1]
}

// RouteKeyProblems refuses a recipient or a text level the body names for a rule that does not read it, and a recipient that is the Operator (a line to them would reach Needs you: it goes through the
// check's own paths, never a member nudge). named is the keys of each rule the body carried ("landing" -> {"on", "to"}).
func RouteKeyProblems(named map[string]map[string]bool, h HealthSettings) string {
	rules := make([]string, 0, len(h.ruleRoutes()))
	for n := range h.ruleRoutes() {
		rules = append(rules, n)
	}
	sort.Strings(rules)
	for _, n := range rules {
		keys := named[n]
		to, text := RouteWired(n)
		if keys["to"] && !to {
			return fmt.Sprintf("%s.to: the %s rule does not read a recipient yet", n, n)
		}
		if keys["text"] && !text {
			return fmt.Sprintf("%s.text: the %s rule does not read a text level yet", n, n)
		}
		if keys["to"] && IsOperatorName(strings.TrimSpace(h.ruleRoutes()[n].To)) {
			return fmt.Sprintf("%s.to: a member of the team, never the Operator (their lines go through Needs you)", n)
		}
	}
	return ""
}
