package routes

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
	setreg "github.com/subgentic/coral/internal/settings"
)

// What reaches Needs you (#12144, the Operator's design v6): the kind switches, the included teams and the time of the daily items are settings of this computer. Questions and decisions have no switch and
// can never be muted by any of them; only a file for review has a kind, and only the kinds that have a switch can be switched off. Settings > Inbox is the Operator's alone: the settings route refuses an
// agent's token (the identity layer), and each value is parsed here, never trusted from the page.

// inboxKindSetting is the setting that switches a kind of file for review.
var inboxKindSetting = map[string]string{
	board.KindFile:    setreg.InboxKindFile,
	board.KindDone:    setreg.InboxKindDone,
	board.KindRelease: setreg.InboxKindRelease,
	board.KindDecided: setreg.InboxKindDecided,
	board.KindDigest:  setreg.InboxKindDigest,
}

// maxInboxTeams bounds the included-teams list.
const maxInboxTeams = 500

var inboxTimeRe = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)

// inboxPrefs is what the Operator chose to reach Needs you, read once for a request.
type inboxPrefs struct {
	off      map[string]bool // a kind switched off
	allTeams bool
	teams    map[string]bool
}

// readInboxPrefs reads the choices from the settings map. An unset, empty or unreadable value is the default: every kind on, every team included.
func readInboxPrefs(s map[string]string) inboxPrefs {
	p := inboxPrefs{off: map[string]bool{}, allTeams: true}
	for kind, key := range inboxKindSetting {
		if !setreg.Bool(s, key) {
			p.off[kind] = true
		}
	}
	raw := strings.TrimSpace(setreg.Text(s, setreg.InboxIncludedTeams))
	if raw == "" || strings.EqualFold(raw, "all") {
		return p
	}
	var list []string
	if err := json.Unmarshal([]byte(raw), &list); err != nil { // a value that cannot be read leaves every team included: never mutes by mistake
		return p
	}
	p.allTeams, p.teams = false, map[string]bool{}
	for _, t := range list {
		p.teams[t] = true
	}
	return p
}

// muted says whether a file of this kind in this team does not reach Needs you: its kind is switched off, or its team is not included. It is asked in this one place for every count, so a per-team choice can be
// read here later with no migration.
func (p inboxPrefs) muted(team, kind string) bool {
	if kind == "" {
		kind = board.KindFile
	}
	return p.off[kind] || (!p.allTeams && !p.teams[team])
}

// validateInboxSettings checks the Needs you settings of a settings PUT: the switches are booleans, the included teams the word all or a list of plain team ids, the time HH:MM (24 hours). Parsed here.
func validateInboxSettings(body map[string]any) error {
	for _, key := range inboxKindSetting {
		if v, ok := body[key]; ok {
			on, valid := validBoolSetting(v)
			if !valid {
				return errors.New(key + " must be true or false")
			}
			body[key] = boolString(on)
		}
	}
	if v, ok := body[setreg.InboxIncludedTeams]; ok {
		s, isString := v.(string)
		if !isString {
			return errors.New(setreg.InboxIncludedTeams + " must be the word all or a list of team ids")
		}
		s = strings.TrimSpace(s)
		if s == "" || strings.EqualFold(s, "all") {
			body[setreg.InboxIncludedTeams] = "all"
		} else {
			var list []string
			if err := json.Unmarshal([]byte(s), &list); err != nil || len(list) > maxInboxTeams {
				return errors.New(setreg.InboxIncludedTeams + " must be the word all or a list of team ids")
			}
			seen := map[string]bool{}
			clean := make([]string, 0, len(list))
			for _, t := range list {
				if t == "" || len(t) > 128 || clitext.CleanName(t) != t { // a plain id: no control, invisible or reordering characters
					return errors.New(setreg.InboxIncludedTeams + " must hold plain team ids")
				}
				if !seen[t] {
					seen[t] = true
					clean = append(clean, t)
				}
			}
			out, _ := json.Marshal(clean)
			body[setreg.InboxIncludedTeams] = string(out)
		}
	}
	if v, ok := body[setreg.InboxDigestTime]; ok {
		s, isString := v.(string)
		if !isString || !inboxTimeRe.MatchString(strings.TrimSpace(s)) {
			return errors.New(setreg.InboxDigestTime + " must be a time of day as HH:MM, 24 hours")
		}
		body[setreg.InboxDigestTime] = strings.TrimSpace(s)
	}
	return nil
}

func boolString(b bool) string {
	if b {
		return "true"
	}
	return "false"
}
