package board

import (
	"fmt"
	"strings"
)

// PiNoticeOpener is the fixed start of the board notice a Pi agent is handed at the end of its turn (#11107 slice 2). Pi gives a message an extension injects to the model as a USER-role message (checked on Pi
// 1.4.0), so nothing but the text itself says it is Coral's: this opener, which Coral's extension checks again before it injects anything, and which no board name or message can change.
const PiNoticeOpener = "[Coral board] "

// piNoticeMax is the longest a Pi notice may be, in characters: it names a count and a board, and the agent reads the rest with coral-board.
const piNoticeMax = 300

// PiBoardNotice is the text Coral hands a Pi agent when its turn ends with unread board messages: the fixed opener, the count and the board's name made fit by TypedLabel (so a board name someone chose cannot
// shape the sentence), and the instruction. It never holds a message's text. It is at most piNoticeMax characters of printable ASCII-safe text.
func PiBoardNotice(unread int, boardName string) string {
	if unread < 1 {
		return ""
	}
	label := asciiLabel(TypedLabel(boardName))
	if label == "" {
		label = "this board"
	}
	plural := "s"
	if unread == 1 {
		plural = ""
	}
	count := fmt.Sprint(unread)
	if unread > 999 {
		count = "999+"
	}
	text := fmt.Sprintf("%s%s new message%s on %s. Run coral-board read to read them, then carry on.", PiNoticeOpener, count, plural, label)
	if len(text) > piNoticeMax { // the label is ASCII and at most 80 runes, so this only guards the sentence's own length
		text = strings.TrimRight(text[:piNoticeMax], " ")
	}
	return text
}

// asciiLabel turns every non-ASCII character of a label into a space and collapses the runs: the hook that passes the notice on drops anything but ASCII (so a board named with accents or CJK would get no notice
// at all, Security on #11133). A result with no letter or digit left (nothing, or only the dots of a cut label) is "": the caller says 'this board'.
func asciiLabel(s string) string {
	out := strings.Join(strings.Fields(strings.Map(func(r rune) rune {
		if r >= 0x80 {
			return ' '
		}
		return r
	}, s)), " ")
	if strings.IndexFunc(out, func(r rune) bool { return r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' }) < 0 {
		return ""
	}
	return out
}
