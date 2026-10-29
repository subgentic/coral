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
	label := TypedLabel(boardName)
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
	if len(text) > piNoticeMax { // a label is at most 80 runes, but they can be multi-byte letters: the bound is on the bytes too
		text = text[:piNoticeMax]
		text = strings.TrimRight(text, " ") // cut on a byte boundary of the letters TypedLabel keeps: a partial rune is not allowed through
		for len(text) > 0 && text[len(text)-1] >= 0x80 {
			text = text[:len(text)-1]
		}
	}
	return text
}
