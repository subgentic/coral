package routes

import (
	"context"
	"regexp"
	"sort"
	"strings"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// SetMemberNameLookup tells the board how to find the display names the dashboard gave its members (a rename sets the session's display name; the board keeps the agent's id), so
// a post may name a member by it and the dashboard's rows say it (#17421).
func (h *BoardHandler) SetMemberNameLookup(fn func(ctx context.Context, project string) map[string]string) {
	h.memberNames = fn
}

// MemberDisplayNames maps a member's board id to the display name the dashboard gave their agent, for the members renamed: one whose name is another member's id or job title, now or in the past, is left
// out (it would name the wrong one), and so is one that is no change, the Operator's or a broadcast word (@all).
func MemberDisplayNames(bs *board.Store, ss *store.SessionStore) func(ctx context.Context, project string) map[string]string {
	return func(ctx context.Context, project string) map[string]string {
		subs, err := bs.ListSubscribers(ctx, project)
		if err != nil {
			return nil
		}
		known := map[string]bool{"operator": true, "all": true, "notify-all": true, "notify_all": true, "notifyall": true} // names that are no agent's: the Operator and the broadcast words (a rename must not take them)
		for _, s := range subs {
			known[strings.ToLower(strings.TrimSpace(s.SubscriberID))] = true
			known[strings.ToLower(strings.TrimSpace(s.JobTitle))] = true
		}
		if former, err := bs.FormerMemberNames(ctx, project); err == nil { // and the names of members who left: a mention meant for one must not reach whoever takes the name (#17720)
			for _, n := range former {
				known[strings.ToLower(strings.TrimSpace(n))] = true
			}
		}
		out := map[string]string{}
		for _, s := range subs {
			sid := naming.SessionIDFromName(s.SessionName)
			if sid == "" {
				continue
			}
			name, err := ss.GetDisplayName(ctx, sid)
			if err != nil || name == nil {
				continue
			}
			if n := strings.TrimSpace(*name); n != "" && !known[strings.ToLower(n)] {
				out[s.SubscriberID] = n
			}
		}
		return out
	}
}

// showCurrentNames puts a renamed member's display name where the dashboard shows who wrote a message (its job title): the rows, the avatars and Reply follow a rename. The stored text and
// the member's board id are not touched.
func (h *BoardHandler) showCurrentNames(ctx context.Context, project string, msgs []board.Message) {
	if h.memberNames == nil || len(msgs) == 0 {
		return
	}
	names := h.memberNames(ctx, project)
	for i := range msgs {
		if n := names[msgs[i].SubscriberID]; n != "" {
			msgs[i].JobTitle = n
		}
	}
}

// useBoardIDs rewrites "@<display name>" to "@<board id>" for the members renamed in the dashboard, so the post is stored (and read, and counted unread) under the id the board knows.
// An @ in the middle of a word, or a name that only starts with the display name, is left alone; a display name two members share names nobody.
func (h *BoardHandler) useBoardIDs(ctx context.Context, project, content string) string {
	if h.memberNames == nil || !strings.Contains(content, "@") {
		return content
	}
	byName := map[string]string{} // lower-cased display name -> board id
	for id, n := range h.memberNames(ctx, project) {
		k := strings.ToLower(n)
		if prev, ok := byName[k]; ok && prev != id {
			byName[k] = "" // two members share it
		} else {
			byName[k] = id
		}
	}
	keys := make([]string, 0, len(byName))
	for k, id := range byName {
		if id != "" {
			keys = append(keys, regexp.QuoteMeta(k))
		}
	}
	if len(keys) == 0 {
		return content
	}
	sort.Slice(keys, func(i, j int) bool { return len(keys[i]) > len(keys[j]) }) // the longest name first
	re := regexp.MustCompile(`(?i)(^|[^\p{L}\p{N}_.])@(` + strings.Join(keys, "|") + `)([^\p{L}\p{N}_-]|$)`)
	for i := 0; i < 2; i++ { // twice: a match consumes the character after it, so "@a @a" needs a second pass
		content = re.ReplaceAllStringFunc(content, func(m string) string {
			sub := re.FindStringSubmatch(m)
			return sub[1] + "@" + byName[strings.ToLower(sub[2])] + sub[3]
		})
	}
	return content
}
