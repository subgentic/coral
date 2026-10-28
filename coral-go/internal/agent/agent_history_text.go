// The text the history index keeps of a conversation: the first message (redacted and clipped), what a person really typed, what is injected, and the full-text search body. Moved out of agent.go (#8334), no code changed.

package agent

import (
	"regexp"
	"strings"

	"github.com/subgentic/coral/internal/secrets"
	"github.com/subgentic/coral/pkg/redact"
)

// HistoryIndexVersion is the version of the History parsers: a session indexed with an older one is read again once (its row has no first user message, #6207). Every scanner stamps it on the rows it
// writes; store.GetHistoryMtimes is given it, so the next pass re-reads the files of older rows whatever their mtime. Version 1 was the guardian-aware Codex parser (#6081); version 4 keeps the launch prompt out of the first user message (#7756); version 5 keeps what Coral typed into the agent (a nudge, a task notice) out of it (#10163); version 6 stores the folder a chat ran in (#10390).
const HistoryIndexVersion = 6

// firstMessageLimit is how much of the first user message is kept.
const firstMessageLimit = 200

// redactBound is how much of a message is looked at for secrets before it is clipped: more than any clip keeps, and a bound on the work for a message of megabytes.
const redactBound = 64 << 10

// redactedCut is the first n bytes of text, redacted BEFORE it is cut and cut where no token can be split (redact.Cut), as a COPY (a substring would keep the whole message alive). A secret that straddles a plain
// byte cut is left as part of a token that the detector no longer recognises: a GitHub token short of its last character passed the redactor unchanged (#3733's class, Security's SHOULD on #6207). Text that
// cannot be checked gives "" (fail closed).
func redactedCut(text string, n int) string {
	if len(text) > redactBound {
		text = strings.ToValidUTF8(text[:redactBound], "")
	}
	out, err := secrets.Redactor().Text([]byte(text))
	if err != nil {
		return ""
	}
	s := string(out)
	return strings.Clone(s[:redact.Cut(s, n)])
}

// clipFirstMessage is the first user message as a short line: redacted whole first (a multi-line secret such as a PEM key is only seen whole), then whitespace folded and at most firstMessageLimit bytes kept,
// cut where no token can be split.
func clipFirstMessage(text string) string {
	if len(text) > redactBound {
		text = strings.ToValidUTF8(text[:redactBound], "")
	}
	out, err := secrets.Redactor().Text([]byte(text))
	if err != nil {
		return ""
	}
	return redactedCut(strings.Join(strings.Fields(string(out)), " "), firstMessageLimit)
}

// ideContextR is one IDE context block the editor extension puts in front of what the person typed (<ide_opened_file>The user opened ...</ide_opened_file>, <ide_selection>...</ide_selection>), at the start of the text.
var ideContextR = regexp.MustCompile(`(?s)^\s*<(ide_[a-z_]+)>.*?</(ide_[a-z_]+)>`)

// typedText is what the person typed in a user entry's text, and whether there is any: the IDE context blocks in front of it are dropped and the rest is kept (#6268: a message that opened with an
// <ide_opened_file> tag was skipped whole, so the title fell to a later message), and an entry that is only context, or the CLI's own text, has none.
func typedText(text string) (string, bool) {
	for {
		m := ideContextR.FindStringSubmatch(text)
		if m == nil || m[1] != m[2] {
			break
		}
		text = text[len(m[0]):]
	}
	// The extension can put its context after the typed text as well (a selection): those blocks are not typed text either.
	for {
		t := strings.TrimRight(text, " \t\r\n")
		m := ideTrailingCloseR.FindStringSubmatch(t)
		if m == nil {
			break
		}
		start := strings.LastIndex(t[:len(t)-len(m[0])], "<"+m[1]+">")
		if start < 0 {
			break // closed but never opened: left as typed
		}
		text = t[:start]
	}
	if injectedUserText(text) || IsCoralDelivery(text) { // what Coral typed into the agent (a nudge, a task notice) is not what the person asked (#10163)
		return "", false
	}
	return text, true
}

// ideTrailingCloseR is the closing tag of an IDE context block at the very end of the text.
var ideTrailingCloseR = regexp.MustCompile(`</(ide_[a-z_]+)>$`)

// Markers of the text Coral itself puts in a chat's launch prompt: the board action prompts say this, and the distilled-knowledge section opens with this heading and sentence (routes.InjectKnowledgeIntoPrompt).
const (
	launchPromptBoardMarker     = "You were automatically joined to message board"
	KnowledgeSectionHeading     = "## Your Institutional Knowledge"
	KnowledgeSectionIntro       = "The following is distilled knowledge from your previous sessions."
	launchPromptKnowledgeMarker = KnowledgeSectionHeading + "\n\n" + KnowledgeSectionIntro
)

// IsLaunchPromptText reports whether a user entry's text is the launch prompt Coral gave the agent (its role prompt with the knowledge section and the board's action text after it), not something a person typed (#7756).
// A launch prompt that has neither the knowledge section nor the board text (a role prompt alone) cannot be told from a typed message here.
func IsLaunchPromptText(text string) bool {
	return strings.Contains(text, launchPromptBoardMarker) || strings.Contains(text, launchPromptKnowledgeMarker)
}

// injectedUserText reports whether a user entry's text is the CLI's own and not something the person typed: a slash command's tags, the output of one, or a system reminder or environment block.
func injectedUserText(text string) bool {
	t := strings.TrimSpace(text)
	for _, p := range []string{"<command-name>", "<command-message>", "<local-command-", "<system-reminder>", "<environment_context>", "<user_instructions>", "<ide_", "<task-notification>", "[Request interrupted by user", "# AGENTS.md instructions for", "Caveat: The messages below were generated by the user while running local commands"} {
		if strings.HasPrefix(t, p) {
			return true
		}
	}
	return t == "" || IsLaunchPromptText(t)
}

// ftsBodyLimit caps how much of one session's text enters the search index.
// A long session can run to megabytes; indexing all of it across hundreds of
// sessions would cost far more disk than the search is worth. 256 KiB is
// roughly a hundred thousand words, which is more than enough for the "what
// was that session about" query this feature exists to answer.
const ftsBodyLimit = 256 * 1024

// FTSBodyBuilder accumulates the searchable text of one session, bounded.
//
// It exists so every agent's extractor builds the body the same way. FTSBody
// was declared and read but never assigned by any of the four extractors, so
// the guard in the indexer was never true, UpsertFTS was never called, and
// session_fts stayed empty — in production, across 56 indexed sessions, for
// months. Building it in one place is what stops three of the four being
// fixed and the fourth quietly not.
type FTSBodyBuilder struct {
	b    strings.Builder
	full bool
}

// Add appends one message's text. Empty strings are ignored, and everything
// after the limit is dropped rather than truncated mid-append, so the body
// never ends in half a word.
func (f *FTSBodyBuilder) Add(text string) {
	if f.full || text == "" {
		return
	}
	if f.b.Len() > 0 {
		f.b.WriteByte('\n')
	}
	f.b.WriteString(text)
	if f.b.Len() >= ftsBodyLimit {
		f.full = true
	}
}

// String returns the accumulated body.
func (f *FTSBodyBuilder) String() string { return f.b.String() }

// buildFTSBody returns the searchable body for a session, seeded with the
// display summary.
//
// Seeding matters: the summary is what the session list shows, so a word a
// user can see on screen must be findable. That was the exact symptom — a
// summary reading "MEMORY-TOKEN-7731 the capital of the demo is Coralville"
// was on screen while a search for "Coralville" returned nothing.
func buildFTSBody(summary string, body *FTSBodyBuilder) string {
	var out FTSBodyBuilder
	out.Add(summary)
	out.Add(body.String())
	return out.String()
}
