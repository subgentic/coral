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
	return MentionGapAmong(name, title, nil, posts)
}

// MentionGapAmong is MentionGap for a member of a team whose members' names are others (their ids and job titles, the member's own included or not): each @ is resolved to the LONGEST of those names it fully
// matches, as delivery does (#12352). A mention of a longer member's name is that member's alone, so it neither reaches this one nor counts as a try at it; and a start of a name is a try only when no member's whole
// name matches at that @ ("@Security Reviewer" is a whole name of one member, and so no try at "Security Reviewer Distributed Systems").
func MentionGapAmong(name, title string, others []string, posts []RecentPost) (n int, oldest time.Time) {
	names := []string{name}
	if strings.TrimSpace(title) != "" {
		names = append(names, title)
	}
	known := append(append([]string{}, others...), names...)
	for _, p := range posts {
		if SameIdentity(p.Sender, name) {
			continue
		}
		if properMention(p.Content, names, known) {
			return 0, time.Time{} // a mention is addressed to it properly: delivered
		}
	}
	for _, p := range posts {
		if SameIdentity(p.Sender, name) || !addressesPrefix(p.Content, names, known) {
			continue
		}
		n++
		if oldest.IsZero() || p.At.Before(oldest) {
			oldest = p.At
		}
	}
	return n, oldest
}

// fullMatchesAt are the names of known that are the whole of what follows an "@" (rest, lower-cased): the text starts with the name and the next character does not continue a word, as delivery reads a mention.
func fullMatchesAt(rest string, known []string) []string {
	var out []string
	for _, n := range known {
		ln := strings.ToLower(strings.TrimSpace(n))
		if ln == "" || !strings.HasPrefix(rest, ln) {
			continue
		}
		if tail := rest[len(ln):]; tail != "" {
			if r := []rune(tail)[0]; unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-' {
				continue
			}
		}
		out = append(out, ln)
	}
	return out
}

// properMention: some @ in content resolves, by the longest member name it fully matches, to one of names (the member's own name or job title).
func properMention(content string, names, known []string) bool {
	lc := strings.ToLower(content)
	for i := 0; i < len(lc); i++ {
		if lc[i] != '@' {
			continue
		}
		longest := 0
		for _, m := range fullMatchesAt(lc[i+1:], known) {
			if len(m) > longest {
				longest = len(m)
			}
		}
		if longest == 0 {
			continue
		}
		for _, n := range names {
			if ln := strings.ToLower(strings.TrimSpace(n)); len(ln) == longest && len(fullMatchesAt(lc[i+1:], []string{ln})) > 0 {
				return true
			}
		}
	}
	return false
}

// addressesPrefix: content has an "@" followed by a word (at least minMentionPrefix characters) that is the start of one of names but not the whole of it, and no member's whole name matches at that "@".
func addressesPrefix(content string, names, known []string) bool {
	lc := strings.ToLower(content)
	for i := 0; i < len(lc); i++ {
		if lc[i] != '@' {
			continue
		}
		if len(fullMatchesAt(lc[i+1:], known)) > 0 {
			continue // some member's whole name is what is addressed here
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

// NameHasEdgePunctuation: a member's name breaks the member-name rule, the one the join refuses (ValidMemberName: start with a letter or a digit, end with a letter, digit or closing bracket), so a mention
// may not reach it; a member made before the rule can have one. "QA (2)" and "Dev (night)" are fine.
func NameHasEdgePunctuation(name string) bool { return ValidMemberName(name) != nil }
