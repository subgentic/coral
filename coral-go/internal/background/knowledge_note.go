package background

import (
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/fsreplace"
	"github.com/subgentic/coral/internal/logsafe"
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
	slug := noteSlug(title)
	if slug == "" {
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
	if noteBeforeCreate != nil {
		noteBeforeCreate() // a test's seam: the moment between looking and creating
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
	// O_EXCL: the create itself refuses a file that is there, so two saves of one title cannot overwrite each other (the look above only gives the common case its message) (#17974).
	f, err := secfile.OpenNoFollow(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return "", false, ErrNoteExists
		}
		return "", false, err
	}
	if _, err := f.WriteString(md); err != nil {
		f.Close()
		os.Remove(path)
		return "", false, err
	}
	if err := f.Close(); err != nil {
		return "", false, err
	}
	return name, md != body, nil
}

// noteBeforeCreate is nil outside tests.
var noteBeforeCreate func()

// noteSlug is a title as a file name part: the agents' rules, without a device-name '_' (the "note-" in front makes the name safe) and with no '_' at the end, which an agent's "note-" file always has (see slugify).
func noteSlug(title string) string {
	return strings.TrimRight(slugifyBase(title), "_")
}

// IsKnowledgeNote reports whether a knowledge file name is a hand-written note: "note-" and no '_' at the end (an agent named note-... is written with one, #17974).
func IsKnowledgeNote(name string) bool {
	return strings.HasPrefix(name, NoteFilePrefix) && !strings.HasSuffix(name, "_")
}

var legacyNoteChecked sync.Map // folders already looked at in this process

// keepLegacyAgentFilesAgentFiles is the one-time step for a folder the release before #17974 wrote (#18293): an agent named note-x had its file at note-x.md, which now reads as
// a hand-written note. A note- file whose front matter is not "type: note" is an agent's: its name gets the '_' agents' names carry now, so it is found as the agent's file.
// A taken name or a failed rename leaves the file as it is and logs a warning: an upgrade is never blocked.
func keepLegacyAgentFilesAgentFiles(dir string) {
	if _, done := legacyNoteChecked.LoadOrStore(dir, true); done {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		legacyNoteChecked.Delete(dir) // no folder yet: look again when there is one
		return
	}
	for _, e := range entries {
		n := e.Name()
		stem := strings.TrimSuffix(n, ".md")
		if e.IsDir() || stem == n || !IsKnowledgeNote(stem) || handWrittenNote(filepath.Join(dir, n)) {
			continue
		}
		to := filepath.Join(dir, stem+"_.md")
		if _, err := os.Lstat(to); err == nil {
			slog.Warn("knowledge: an agent's file named like a note was left as it is: its new name is taken", "file", logsafe.Path(n))
			continue
		}
		if err := fsreplace.Rename(filepath.Join(dir, n), to); err != nil {
			slog.Warn("knowledge: an agent's file named like a note was not renamed", "file", logsafe.Path(n), "error", err)
		}
	}
}

// handWrittenNote reports whether a file's front matter says "type: note" (AddKnowledgeNote writes it); an unreadable file counts as a note, so it is never moved.
func handWrittenNote(path string) bool {
	b, err := os.ReadFile(path)
	if err != nil {
		return true
	}
	lines := strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return false
	}
	for _, l := range lines[1:] {
		if strings.TrimSpace(l) == "---" {
			break
		}
		if strings.TrimSpace(l) == "type: note" {
			return true
		}
	}
	return false
}
