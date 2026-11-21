package board

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// HealthKey is one setting of HealthSettings as `coral-board health settings show` lists it (#20136): its JSON path, its value, its default, and in words what it accepts. The list is made from the struct's own JSON,
// so a setting added to HealthSettings is listed with no second table to keep in step; healthKeyRanges holds the words for the numbers, and a census test fails for a key that has none.
type HealthKey struct {
	Key     string `json:"key"`
	Kind    string `json:"kind"` // bool, int, text, list
	Value   any    `json:"value"`
	Default any    `json:"default"`
	Range   string `json:"range"`
	Free    bool   `json:"free_text"` // the value is text a person typed (a branch, a tag pattern, a member): a change is logged as "changed", not with the text
}

// healthKeyRanges: the accepted range of each number, as Clamp and the Problem checks enforce it.
var healthKeyRanges = map[string]string{
	"interval_min": "5 to 1440 minutes", "heartbeat_min": "0 (never) or 5 to 1440 minutes", "assign_limit": "0 (no limit) to 50", "stale_sweep_hours": "0 (off) to 720 hours", "park_limit": "1 to 20",
	"claim_nudge.after_min": "5 to 1440 minutes", "claim_nudge.nudges": "1 to 5", "status_nudge.after_min": "5 to 1440 minutes", "status_nudge.escalate_after_min": "5 to 1440 minutes",
	"mention_renudge.after_min": "5 to 1440 minutes", "held_notice.after_min": "5 to 1440 minutes", "busy_no_task.after_min": "5 to 1440 minutes", "ask_reminder.after_min": "5 to 1440 minutes",
	"goal_size.limit": "5 to 500", "compact_context.threshold_k": "50 to 900 (thousand tokens)",
	"action_list.stuck_wait_min": "5 to 1440 minutes", "action_list.overloaded_tasks": "1 to 100", "action_list.overloaded_sleeping": "1 to 50", "action_list.stale_review_hours": "1 to 720 hours", "action_list.mention_min": "5 to 1440 minutes",
	"landing.wait_min": fmt.Sprintf("%d to %d minutes", LandingWaitMin, LandingWaitMax), "release.wait_min": fmt.Sprintf("%d to %d minutes", ReleaseWaitMin, ReleaseWaitMax),
	"goals_ready.wait_min": fmt.Sprintf("%d to %d minutes", WaitCheckMin, WaitCheckMax), "unowned_tasks.wait_min": fmt.Sprintf("%d to %d minutes", WaitCheckMin, WaitCheckMax), "unowned_tasks.max_list": "1 to 20", "goals_ready.max_list": "(not used)",
	"dialog_timeout.after_min": fmt.Sprintf("%d to %d minutes", DialogTimeoutMin, DialogTimeoutMax), "auto_recommend.grace_min": fmt.Sprintf("1 to %d minutes", AutoRecommendGraceMax),
	"operator_wait.grace_min": "1 to 120 minutes", "operator_wait.chat_max_age_min": "5 to 1440 minutes", "deviations.min_age_min": "0 (no floor) to 1440 minutes", "deviations.factor_pct": "100 to 1000 (percent of the usual threshold)", "deviations.min_samples": "0 (the rule's own minimums) to 50", "off_books.post_grace_min": "1 to 30 minutes", "off_books.max_lines": "1 to 20", "pool_review.after_min": "5 to 1440 minutes", "wait_escalate.after_min": "5 to 1440 minutes",
}

// healthKeyWords: the accepted words of the settings that are text.
var healthKeyWords = map[string]string{
	"operator_wait.authors_exempt": "member names, at most 8", "recipient": "a member of this team, or empty for the Orchestrator", "default_reviewers": "member names, at most 8", "reviewer_pool": "member names, at most 12",
	"landing.branch": "a branch name (letters, digits, . _ - /)", "release.branch": "a branch name (letters, digits, . _ - /)", "release.tag_pattern": "a tag glob such as v*",
	"compact_context.trigger": "threshold, task or both", "compact_context.method": "compact, clear_next or clear_handoff",
}

func healthKeyRange(key, kind string) string {
	switch {
	case strings.HasSuffix(key, ".text"):
		if _, ok := routeWired[strings.TrimSuffix(key, ".text")]; ok {
			if _, text := RouteWired(strings.TrimSuffix(key, ".text")); !text {
				return "(this rule does not read a text level yet)"
			}
		} else {
			return "(this rule does not read a text level yet)"
		}
		return "short, normal or long"
	case strings.HasSuffix(key, ".to"):
		if to, _ := RouteWired(strings.TrimSuffix(key, ".to")); !to {
			return "(this rule does not read a recipient yet)"
		}
		return "a member of this team (never the Operator), or empty"
	case strings.HasSuffix(key, ".nudge"):
		return "a member of this team (never the Operator), or empty"
	case kind == "bool":
		return "on or off (true or false)"
	}
	if r, ok := healthKeyRanges[key]; ok {
		return r
	}
	return healthKeyWords[key]
}

// HealthKeys lists every setting of h with its default, in key order.
func HealthKeys(h HealthSettings) []HealthKey {
	cur, def := healthLeaves(h), healthLeaves(DefaultHealthSettings())
	keys := make([]string, 0, len(cur))
	for k := range cur {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]HealthKey, 0, len(keys))
	for _, k := range keys {
		v := cur[k]
		kind := "text"
		switch v.(type) {
		case bool:
			kind = "bool"
		case float64:
			kind = "int"
		case []any, nil:
			kind = "list"
		}
		free := kind == "text" && !strings.HasSuffix(k, ".text") && k != "compact_context.trigger" && k != "compact_context.method" || kind == "list"
		out = append(out, HealthKey{Key: k, Kind: kind, Value: shownLeaf(v), Default: shownLeaf(def[k]), Range: healthKeyRange(k, kind), Free: free})
	}
	return out
}

func shownLeaf(v any) any {
	if l, ok := v.([]any); ok {
		s := make([]string, 0, len(l))
		for _, x := range l {
			s = append(s, fmt.Sprint(x))
		}
		return strings.Join(s, ",")
	}
	if v == nil {
		return ""
	}
	if f, ok := v.(float64); ok {
		return int(f)
	}
	return v
}

func healthLeaves(h HealthSettings) map[string]any {
	raw, _ := json.Marshal(h)
	var tree map[string]any
	_ = json.Unmarshal(raw, &tree)
	out := map[string]any{}
	var walk func(prefix string, x any)
	walk = func(prefix string, x any) {
		if m, ok := x.(map[string]any); ok {
			for k, c := range m {
				name := k
				if prefix != "" {
					name = prefix + "." + k
				}
				walk(name, c)
			}
			return
		}
		out[prefix] = x
	}
	walk("", tree)
	// to and text are left out of the JSON when empty; every rule still has both settings.
	for name := range h.ruleRoutes() {
		for _, f := range []string{"to", "text"} {
			if _, ok := out[name+"."+f]; !ok {
				out[name+"."+f] = ""
			}
		}
	}
	return out
}

// HealthPatchFor is the patch body (nested as HealthSettings is) that sets key to the text value, or what is wrong with the key or the value, in words. kind comes from the key's current kind, so a number is a number.
func HealthPatchFor(key, value string) (patch map[string]any, err error) {
	var found *HealthKey
	for _, k := range HealthKeys(DefaultHealthSettings()) {
		if k.Key == key {
			k := k
			found = &k
			break
		}
	}
	if found == nil {
		return nil, fmt.Errorf("%q is not a health setting; `coral-board health settings show` lists them", key)
	}
	var v any
	switch found.Kind {
	case "bool":
		switch strings.ToLower(value) {
		case "on", "true", "yes", "1":
			v = true
		case "off", "false", "no", "0":
			v = false
		default:
			return nil, fmt.Errorf("%s: %q is not on or off", key, value)
		}
	case "int":
		n, e := strconv.Atoi(strings.TrimSpace(value))
		if e != nil {
			return nil, fmt.Errorf("%s: %q is not a whole number (%s)", key, value, found.Range)
		}
		v = n
	case "list":
		l := []string{}
		for _, p := range strings.Split(value, ",") {
			if p = strings.TrimSpace(p); p != "" {
				l = append(l, p)
			}
		}
		v = l
	default:
		v = value
	}
	parts := strings.Split(key, ".")
	patch = map[string]any{}
	cur := patch
	for i, p := range parts {
		if i == len(parts)-1 {
			cur[p] = v
			break
		}
		next := map[string]any{}
		cur[p] = next
		cur = next
	}
	return patch, nil
}

// HealthOutOfRange is, for the settings a patch named (their keys), the first whose value Clamp would change, in words: a form's save quietly keeps a number in its range, but `health settings set` refuses it and
// says what is accepted, so a person is never told "set" about a number that was not.
func HealthOutOfRange(merged HealthSettings, keys []string) string {
	raw, clamped := healthLeaves(merged), healthLeaves(merged.Clamp())
	sort.Strings(keys)
	for _, k := range keys {
		if fmt.Sprint(raw[k]) != fmt.Sprint(clamped[k]) {
			kind := "text"
			if _, ok := raw[k].(float64); ok {
				kind = "int"
			}
			if r := healthKeyRange(k, kind); r != "" {
				return fmt.Sprintf("%s: %s is not accepted (%s)", k, fmt.Sprint(shownLeaf(raw[k])), r)
			}
			return fmt.Sprintf("%s: %s is not accepted", k, fmt.Sprint(shownLeaf(raw[k])))
		}
	}
	return ""
}

// HealthPatchKeys is the dotted keys a nested patch names.
func HealthPatchKeys(patch []byte) []string {
	var tree any
	if json.Unmarshal(patch, &tree) != nil {
		return nil
	}
	var out []string
	var walk func(prefix string, x any)
	walk = func(prefix string, x any) {
		if m, ok := x.(map[string]any); ok {
			for k, c := range m {
				n := k
				if prefix != "" {
					n = prefix + "." + k
				}
				walk(n, c)
			}
			return
		}
		out = append(out, prefix)
	}
	walk("", tree)
	return out
}

// HealthChanges is the keys of the settings that differ between two values, with each old and new value as `show` prints it; a setting that is text a person typed has no old or new text, only "changed".
func HealthChanges(before, after HealthSettings) []HealthChange {
	b, a := HealthKeys(before), HealthKeys(after)
	var out []HealthChange
	for i := range b {
		if fmt.Sprint(b[i].Value) == fmt.Sprint(a[i].Value) {
			continue
		}
		c := HealthChange{Key: b[i].Key, Old: fmt.Sprint(b[i].Value), New: fmt.Sprint(a[i].Value)}
		if b[i].Free {
			c.Old, c.New = "", "changed"
		}
		out = append(out, c)
	}
	return out
}

// HealthChange is one setting that changed.
type HealthChange struct{ Key, Old, New string }

// HealthSettingsLog is the health setting changes made through `health settings set|reset` or the route since a time, newest first: who, when, the key and the old and new value ("changed" for text a person typed).
// It is what a daily digest line "the Orchestrator changed N health settings" counts.
func (s *Store) HealthSettingsLog(ctx context.Context, project string, since time.Time) ([]LogEntry, error) {
	var rows []struct {
		ID    int64  `db:"id"`
		At    string `db:"at"`
		Actor string `db:"actor"`
		Field string `db:"field"`
		Old   string `db:"old_value"`
		New   string `db:"new_value"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT id, at, actor, field, old_value, new_value FROM board_settings_log WHERE board_id = ? AND kind = ? AND field LIKE 'health.%' AND at >= ? ORDER BY id DESC LIMIT 200`,
		project, LogEdit, since.UTC().Format("2006-01-02T15:04:05.000Z")); err != nil {
		return nil, err
	}
	out := make([]LogEntry, 0, len(rows))
	for _, r := range rows {
		out = append(out, LogEntry{ID: r.ID, At: r.At, Kind: LogEdit, Actor: r.Actor, Field: r.Field, Old: r.Old, New: r.New})
	}
	return out, nil
}
