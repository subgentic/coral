package agent

import (
	"strconv"
	"strings"
	"time"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// opencode keeps no transcript file Coral reads: its history is what its server's message API gives (#11383), so the indexer is handed the messages and builds the same row every other agent's file gives.

// OpencodeHistoryMessage is one message of an opencode session: who said it, its text and when (as the API wrote it).
type OpencodeHistoryMessage struct {
	Role string // "user" or "assistant"
	Text string
	At   string
}

// OpencodeSourcePrefix starts the SourceFile of an opencode session's history row: the agent's Coral id after it. It is a label, never a path of this computer or of the server, and never opened.
const OpencodeSourcePrefix = "opencode://"

// IndexOpencodeSession is the history row of one opencode agent's session: its Coral session id, its messages (at most what the manager read, which holds the byte budget) and the time it last changed (unix
// seconds, which is what tells the indexer the row is unchanged). Built as Pi's is: the summary and the first message redacted before they are clipped, the search body the text of what was said, bounded.
func IndexOpencodeSession(sessionID string, msgs []OpencodeHistoryMessage, mtime float64) *IndexedSession {
	var fts FTSBodyBuilder
	var firstTS, lastTS *string
	var summary, firstMsg string
	count := 0
	for _, m := range msgs {
		if (m.Role != "user" && m.Role != "assistant") || m.Text == "" {
			continue
		}
		count++
		if ts := opencodeRFC3339(m.At); ts != "" {
			if firstTS == nil {
				first := ts
				firstTS = &first
			}
			last := ts
			lastTS = &last
		}
		fts.Add(m.Text)
		if m.Role == "user" && !IsCoralDelivery(m.Text) {
			if firstMsg == "" {
				if t, ok := typedText(m.Text); ok {
					firstMsg = clipFirstMessage(t)
				}
			}
			if summary == "" {
				summary = redactedCut(m.Text, 200)
			}
		}
	}
	return &IndexedSession{
		SessionID:        sessionID,
		SourceType:       at.Opencode,
		SourceFile:       OpencodeSourcePrefix + sessionID,
		FileMtime:        mtime,
		FirstTimestamp:   firstTS,
		LastTimestamp:    lastTS,
		MessageCount:     count,
		DisplaySummary:   summary,
		FirstUserMessage: firstMsg,
		IndexVersion:     HistoryIndexVersion,
		FTSBody:          buildFTSBody(summary, &fts),
	}
}

// opencodeRFC3339 is a message time as RFC 3339: the server may send epoch milliseconds. "" when it is neither.
func opencodeRFC3339(s string) string {
	s = strings.TrimSpace(s)
	if ms, err := strconv.ParseInt(s, 10, 64); err == nil && ms > 0 {
		return time.UnixMilli(ms).UTC().Format(time.RFC3339Nano)
	}
	if _, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return s
	}
	return ""
}
