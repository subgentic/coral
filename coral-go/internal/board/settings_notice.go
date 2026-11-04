package board

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/safego"
)

// A change of a team's settings is told to the team's Orchestrator (#13173, the Operator): what changed, from what to what, and who changed it, as one message from "Coral Settings" per save. The settings are
// the Operator's alone, and they decide how the team works, so the Orchestrator should not learn of one from a changed behaviour.

// SettingsSender is the sender of those messages; a member cannot take the name (ReservedNames).
const SettingsSender = "Coral Settings"

// SettingsNoticeDelay is how long a change waits for the next one of the same team before it is told: a slider dragged through ten values is one message, with the value it started from and the one it ended on.
var SettingsNoticeDelay = 3 * time.Second

// SettingChange is one setting that changed: its name, and its value before and after, as short plain text (already cleaned of secrets by the caller).
type SettingChange struct {
	Name, Old, New string
}

const (
	settingValueMax   = 80   // runes of one value shown
	settingChangesMax = 10   // changes named in one message; the rest are counted
	settingNoticeMax  = 1600 // bytes of the message
)

// settingsDerived are keys that restate another and only add noise to a message (the "set" flags of the two cross-team switches).
var settingsDerived = map[string]bool{"cross_team_messaging_set": true, "cross_team_artifacts_set": true}

// DiffSettings lists what differs between two settings values (structs or maps, compared by their JSON), by dotted name, sorted: "health.landing.nudge", "max_open_goals". Nested objects are walked, a list or a
// scalar is one value.
func DiffSettings(before, after any) []SettingChange {
	b, a := settingsFlat(before), settingsFlat(after)
	names := map[string]bool{}
	for k := range b {
		names[k] = true
	}
	for k := range a {
		names[k] = true
	}
	var out []SettingChange
	for name := range names {
		if settingsDerived[name] {
			continue
		}
		ov, nv := b[name], a[name]
		if ov == nv {
			continue
		}
		out = append(out, SettingChange{Name: name, Old: ov, New: nv})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func settingsFlat(v any) map[string]string {
	out := map[string]string{}
	raw, err := json.Marshal(v)
	if err != nil {
		return out
	}
	var tree any
	if err := json.Unmarshal(raw, &tree); err != nil {
		return out
	}
	var walk func(prefix string, x any, depth int)
	walk = func(prefix string, x any, depth int) {
		if m, ok := x.(map[string]any); ok && depth < 5 {
			for k, c := range m {
				name := k
				if prefix != "" {
					name = prefix + "." + k
				}
				walk(name, c, depth+1)
			}
			return
		}
		out[prefix] = settingValueText(x)
	}
	walk("", tree, 0)
	delete(out, "")
	return out
}

// settingValueText is a value as plain words: on and off for a bool, "(none)" for an empty one, a list joined, long text cut.
func settingValueText(x any) string {
	var s string
	switch v := x.(type) {
	case nil:
		s = ""
	case bool:
		if v {
			s = "on"
		} else {
			s = "off"
		}
	case string:
		s = v
	case float64:
		s = fmt.Sprint(v)
	case []any:
		parts := make([]string, 0, len(v))
		for _, e := range v {
			if _, nested := e.(map[string]any); nested {
				raw, _ := json.Marshal(e)
				parts = append(parts, string(raw))
			} else {
				parts = append(parts, settingValueText(e))
			}
		}
		s = strings.Join(parts, ", ")
	default:
		raw, _ := json.Marshal(v)
		s = string(raw)
	}
	s = strings.Join(strings.Fields(s), " ")
	if s == "" {
		return "(none)"
	}
	if r := []rune(s); len(r) > settingValueMax {
		s = string(r[:settingValueMax]) + "…"
	}
	return s
}

// SettingsNoticeText is the message: "The Operator changed max_open_goals: 3 -> 5; health.enabled: on -> off." who is the words for the changer ("The Operator").
func SettingsNoticeText(who string, changes []SettingChange) string {
	if len(changes) == 0 {
		return ""
	}
	parts := make([]string, 0, len(changes))
	for i, c := range changes {
		if i == settingChangesMax {
			parts = append(parts, fmt.Sprintf("and %d more", len(changes)-settingChangesMax))
			break
		}
		parts = append(parts, fmt.Sprintf("%s: %s -> %s", c.Name, c.Old, c.New))
	}
	text := who + " changed " + strings.Join(parts, "; ") + "."
	if len(text) > settingNoticeMax {
		text = strings.ToValidUTF8(text[:settingNoticeMax-4], "") + "…" // cut on a character, not in the middle of one
	}
	return text
}

type settingsPending struct {
	who, actorID string
	order        []string
	changes      map[string]*SettingChange
}

// NoteSettingsChange tells the team's Orchestrator that a setting changed, after SettingsNoticeDelay and together with any other change of the team made meanwhile (the first "from" and the last "to" of each
// setting; one that ended where it began is not told). who is how the message names the changer; actorID is who made the change, and an Orchestrator's own change is not told back to it. Nothing is
// told when the team has no Orchestrator. It never blocks and never fails the save.
func (s *Store) NoteSettingsChange(project, who, actorID string, changes []SettingChange) {
	if len(changes) == 0 {
		return
	}
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	if s.settingsPending == nil {
		s.settingsPending = map[string]*settingsPending{}
	}
	p := s.settingsPending[project]
	if p == nil {
		p = &settingsPending{changes: map[string]*SettingChange{}}
		s.settingsPending[project] = p
		time.AfterFunc(SettingsNoticeDelay, func() {
			defer safego.Recover("board:settingsNotice")
			s.FlushSettingsNotice(context.Background(), project)
		})
	}
	p.who, p.actorID = who, actorID
	for _, c := range changes {
		if cur := p.changes[c.Name]; cur != nil {
			cur.New = c.New
			continue
		}
		cc := c
		p.changes[c.Name] = &cc
		p.order = append(p.order, c.Name)
	}
}

// FlushSettingsNotice tells the changes waiting for the team now (the timer's end; a test's way to not wait).
func (s *Store) FlushSettingsNotice(ctx context.Context, project string) {
	s.settingsMu.Lock()
	p := s.settingsPending[project]
	delete(s.settingsPending, project)
	s.settingsMu.Unlock()
	if p == nil {
		return
	}
	var changes []SettingChange
	for _, name := range p.order {
		if c := p.changes[name]; c.Old != c.New {
			changes = append(changes, *c)
		}
	}
	sort.Slice(changes, func(i, j int) bool { return changes[i].Name < changes[j].Name })
	if len(changes) == 0 {
		return
	}
	subs, err := s.ListSubscribers(ctx, project)
	if err != nil {
		slog.Warn("settings notice: could not list the team", "board", project, "error", err)
		return
	}
	var titles []string
	seen := map[string]bool{}
	for _, sub := range subs {
		orch := sub.CanPeek != 0 || strings.Contains(strings.ToLower(sub.JobTitle), "orchestrator")
		if !orch {
			continue
		}
		if p.actorID != "" && strings.EqualFold(sub.SubscriberID, p.actorID) {
			return // its own change is not told back to it
		}
		if t := strings.TrimSpace(sub.JobTitle); t != "" && !seen[strings.ToLower(t)] {
			seen[strings.ToLower(t)] = true
			titles = append(titles, "@"+t)
		}
	}
	if len(titles) == 0 {
		return
	}
	// The text quotes what a person typed (a setting's value, the Hub user's name): cleaned, and no "@" in it can mention a member or "@all"; only the Orchestrators' own titles in front are live.
	body := DefuseMentions(clitext.Clean(SettingsNoticeText(p.who, changes)), s.BoardMentionNames(ctx, project))
	if _, err := s.PostSystemDefusedMessage(ctx, project, SettingsSender, strings.Join(titles, " ")+" "+body, nil); err != nil {
		slog.Warn("settings notice: could not post", "board", project, "error", err)
	}
}
