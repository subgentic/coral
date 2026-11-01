package board

import (
	"context"
	"strings"
	"time"
	"unicode"
)

// Mentions that do not reach (#11729 rule 4): a member that no post has mentioned for a while, while posts keep @-addressing a prefix of its name, or whose name starts or ends with punctuation.

// RecentPost is a member's board post in a window, for the mention rule.
type RecentPost struct {
	Sender  string
	Content string
	At      time.Time
}

// maxRecentPosts bounds what the rule reads: the newest posts of the window.
const maxRecentPosts = 1000

// RecentPosts lists the non-system posts on project since since, newest first, at most maxRecentPosts.
func (s *Store) RecentPosts(ctx context.Context, project string, since time.Time) ([]RecentPost, error) {
	var rows []struct {
		Sender  string `db:"subscriber_id"`
		Content string `db:"content"`
		At      string `db:"created_at"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT subscriber_id, content, created_at FROM board_messages
		WHERE project = ? AND created_at > ? AND COALESCE(is_system, 0) = 0 ORDER BY id DESC LIMIT ?`,
		project, since.UTC().Format(time.RFC3339), maxRecentPosts); err != nil {
		return nil, err
	}
	out := make([]RecentPost, 0, len(rows))
	for _, r := range rows {
		at, _ := time.Parse(time.RFC3339, r.At)
		out = append(out, RecentPost{Sender: r.Sender, Content: r.Content, At: at})
	}
	return out, nil
}

// minMentionPrefix is the shortest "@..." that counts as addressing a member by a part of its name.
const minMentionPrefix = 3

// MentionGap reports, for the member (its name and job title), how many posts in posts @-address a part of its name without being a mention of it, and when the oldest was: both zero when any post
// mentions it properly (a mention reached it: nothing is lost) or when none of them tries. A post by the member itself is never a try.
func MentionGap(name, title string, posts []RecentPost) (n int, oldest time.Time) {
	names := []string{name}
	if strings.TrimSpace(title) != "" {
		names = append(names, title)
	}
	for _, p := range posts {
		if SameIdentity(p.Sender, name) {
			continue
		}
		if len(mentionedNames(p.Content, names)) > 0 {
			return 0, time.Time{} // a mention is addressed to it properly: delivered
		}
	}
	for _, p := range posts {
		if SameIdentity(p.Sender, name) || !addressesPrefix(p.Content, names) {
			continue
		}
		n++
		if oldest.IsZero() || p.At.Before(oldest) {
			oldest = p.At
		}
	}
	return n, oldest
}

// addressesPrefix: content has an "@" followed by a word (at least minMentionPrefix characters) that is the start of one of names but not the whole of it.
func addressesPrefix(content string, names []string) bool {
	lc := strings.ToLower(content)
	for i := 0; i < len(lc); i++ {
		if lc[i] != '@' {
			continue
		}
		var word []rune
		for _, r := range lc[i+1:] {
			if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-' {
				word = append(word, r)
				continue
			}
			break
		}
		if len(word) < minMentionPrefix {
			continue
		}
		for _, n := range names {
			ln := []rune(strings.ToLower(n))
			if len(word) < len(ln) && strings.HasPrefix(string(ln), string(word)) {
				return true // "@Backend" for "Backend Dev": a part of the name, not the name
			}
		}
	}
	return false
}

// NameHasEdgePunctuation: a member's name starts or ends with punctuation or a symbol, which a mention parser may not read as part of the name.
func NameHasEdgePunctuation(name string) bool {
	r := []rune(strings.TrimSpace(name))
	if len(r) == 0 {
		return false
	}
	edge := func(c rune) bool { return unicode.IsPunct(c) || unicode.IsSymbol(c) }
	return edge(r[0]) || edge(r[len(r)-1])
}
