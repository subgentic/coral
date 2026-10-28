package board

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

// Same-computer team links (#9893, the design note of #9875): a link is an entry {server: "local", cross_team_id: <sender>} on the TARGET board's cross_team_allowed list, one direction per
// entry ("A may message B" lives on B). coral-board link writes both directions in one transaction by default. Every function here works on the same list the settings route edits, so the
// dashboard, the settings route and the command line see one set of links; nothing here changes whether the list is enforced (the global switch cross_team_allowlist does that).

// LocalLinkEdit adds or removes one sender on one target board's list.
type LocalLinkEdit struct {
	Target string        // the board whose list changes (its id)
	Sender AllowedSender // the sender on this Coral: Server is forced to LocalServer; Files is the grant (nil leaves an existing entry's as it is, and a new entry's absent)
	Remove bool
}

// LocalLinkChange is one board's list before and after an ApplyLocalLinks, for the audit log.
type LocalLinkChange struct {
	Target        string
	Before, After []AllowedSender
}

// ErrLinkListFull is a target board whose list is at MaxAllowedSenders.
var ErrLinkListFull = errors.New("the board's list of senders is full")

// ApplyLocalLinks applies edits in ONE transaction: all of them or none. An entry already there is updated (its files grant, its label), never duplicated; removing one that is not there is
// fine. A board is not linked to itself (selfIDs maps a target to its own cross-team id). Only the boards whose list changed are returned.
func (s *Store) ApplyLocalLinks(ctx context.Context, edits []LocalLinkEdit, selfIDs map[string]string) ([]LocalLinkChange, error) {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	lists := map[string][]AllowedSender{}
	before := map[string][]AllowedSender{}
	var order []string
	load := func(target string) error {
		if _, ok := lists[target]; ok {
			return nil
		}
		var raw string
		err := tx.GetContext(ctx, &raw, `SELECT value FROM board_settings WHERE project = ? AND key = ?`, target, settingCrossTeamAllowed)
		var list []AllowedSender
		if err == nil {
			_ = json.Unmarshal([]byte(raw), &list)
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		lists[target] = list
		before[target] = append([]AllowedSender(nil), list...)
		order = append(order, target)
		return nil
	}
	for _, e := range edits {
		if !ValidCrossTeamID(e.Sender.CrossTeamID) {
			return nil, fmt.Errorf("%q is not a board's cross-team id", e.Sender.CrossTeamID)
		}
		if selfIDs[e.Target] == e.Sender.CrossTeamID {
			return nil, errors.New("a board is not linked to itself")
		}
		if err := load(e.Target); err != nil {
			return nil, err
		}
		list := lists[e.Target]
		at := -1
		for i, x := range list {
			if x.Server == LocalServer && x.CrossTeamID == e.Sender.CrossTeamID {
				at = i
				break
			}
		}
		switch {
		case e.Remove && at >= 0:
			list = append(list[:at:at], list[at+1:]...)
		case e.Remove:
		case at >= 0:
			if e.Sender.Files != nil {
				v := *e.Sender.Files
				list[at].Files = &v
			}
			if l := CleanClaimedLabel(e.Sender.Label); l != "" {
				list[at].Label = l
			}
		default:
			if len(list) >= MaxAllowedSenders {
				return nil, ErrLinkListFull
			}
			n := AllowedSender{Server: LocalServer, CrossTeamID: e.Sender.CrossTeamID, Label: CleanClaimedLabel(e.Sender.Label)}
			if e.Sender.Files != nil {
				v := *e.Sender.Files
				n.Files = &v
			}
			list = append(list, n)
		}
		lists[e.Target] = list
	}
	var changes []LocalLinkChange
	for _, target := range order {
		raw, err := json.Marshal(nonNilList(lists[target]))
		if err != nil {
			return nil, err
		}
		old, _ := json.Marshal(nonNilList(before[target]))
		if string(raw) == string(old) {
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO board_settings (project, key, value) VALUES (?, ?, ?)
			ON CONFLICT (project, key) DO UPDATE SET value = excluded.value`, target, settingCrossTeamAllowed, string(raw)); err != nil {
			return nil, err
		}
		changes = append(changes, LocalLinkChange{Target: target, Before: before[target], After: lists[target]})
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return changes, nil
}

func nonNilList(l []AllowedSender) []AllowedSender {
	if l == nil {
		return []AllowedSender{}
	}
	return l
}

// LocalLinkTo is one board that lists a sender, for a view of who a team may message.
type LocalLinkTo struct {
	Target string // the board that lists the sender (its id)
	Files  *bool
}

// BoardsListing returns the boards (by id) whose list holds the local sender id, with the entry's files grant: the teams that sender may message.
func (s *Store) BoardsListing(ctx context.Context, senderID string) ([]LocalLinkTo, error) {
	if !ValidCrossTeamID(senderID) {
		return nil, nil
	}
	var rows []struct {
		Project string `db:"project"`
		Value   string `db:"value"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT project, value FROM board_settings WHERE key = ? AND instr(value, ?) > 0`, settingCrossTeamAllowed, senderID); err != nil {
		return nil, err
	}
	var out []LocalLinkTo
	for _, r := range rows {
		var list []AllowedSender
		if json.Unmarshal([]byte(r.Value), &list) != nil {
			continue
		}
		for _, e := range list {
			if e.Server == LocalServer && e.CrossTeamID == senderID {
				out = append(out, LocalLinkTo{Target: r.Project, Files: e.Files})
				break
			}
		}
	}
	return out, nil
}
