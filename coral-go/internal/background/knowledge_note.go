package background

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/secfile"
)

// A note a person writes by hand into a team's knowledge (#17485): a file of its own in the team's knowledge folder, named note-<title as a slug>.md, with the front matter the distillation writes (type: note, title).
// It is never an agent's file (the note- name, and a title that already has a note is refused), so a distillation, which writes only the agents' files and the index, leaves it as it is.
const (
	NoteFilePrefix = "note-"
	MaxNoteTitle   = 120
	MaxNoteText    = 20000
)

var (
	ErrBadNoteTitle = errors.New("a note needs a title of up to 120 characters on one line, with a letter or digit in it")
	ErrBadNoteText  = errors.New("a note needs some text, up to 20000 characters")
	ErrNoteExists   = errors.New("a note with this title already exists: open it to change it, or give this one another title")
)

// noteTitleOK reports whether title is one line of printable text.
func noteTitleOK(title string) bool {
	if title == "" || utf8.RuneCountInString(title) > MaxNoteTitle {
		return false
	}
	for _, r := range title {
		if r < 0x20 || r == 0x7f || r == 0x2028 || r == 0x2029 {
			return false
		}
	}
	return true
}

// yamlQuote makes title one double-quoted YAML scalar.
func yamlQuote(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}

// AddKnowledgeNote writes a new note into the team's knowledge, redacted like every knowledge file, and returns its file name (the slug, without .md). A team with no knowledge yet gets a one-line index so the folder reads as a bundle.
// It never replaces a note: a title that is taken is ErrNoteExists.
func AddKnowledgeNote(coralDir, team, title, text string) (name string, redacted bool, err error) {
	title = strings.TrimSpace(title)
	if !noteTitleOK(title) {
		return "", false, ErrBadNoteTitle
	}
	text = strings.TrimSpace(text)
	if text == "" || utf8.RuneCountInString(text) > MaxNoteText {
		return "", false, ErrBadNoteText
	}
	slug := slugify(title)
	if slug == "" || slug == "_" {
		return "", false, ErrBadNoteTitle
	}
	name = NoteFilePrefix + slug
	dir, err := knowledgeTeamDir(coralDir, team)
	if err != nil {
		return "", false, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", false, err
	}
	path := filepath.Join(dir, name+".md")
	if _, err := os.Lstat(path); err == nil {
		return "", false, ErrNoteExists
	}
	body := "---\ntype: note\ntitle: " + yamlQuote(title) + "\n---\n\n" + text + "\n"
	md, err := redactKnowledge(body) // never written unredacted (#4414)
	if err != nil {
		return "", false, errors.New("the note was not saved: it could not be checked for secrets: " + err.Error())
	}
	if b, rerr := ReadKnowledgeBundle(coralDir, team); rerr == nil && b == nil {
		if err := WriteKnowledgeIndex(coralDir, team, "---\ntype: index\n---\n\n# Knowledge\n\nNotes added by hand. Distill knowledge adds what each agent learned.\n"); err != nil {
			return "", false, err
		}
	}
	if err := secfile.WriteFileNoFollow(path, []byte(md), 0o600); err != nil {
		return "", false, err
	}
	return name, md != body, nil
}

// IsKnowledgeNote reports whether a knowledge file name is a hand-written note.
func IsKnowledgeNote(name string) bool { return strings.HasPrefix(name, NoteFilePrefix) }
