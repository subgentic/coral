package tmux

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// A Windows clipboard's multi-line text reached a tmux agent with every line break doubled: paste-buffer turns each LF into a CR, and the CR of a CRLF stayed (#11265, input-fidelity multiline-crlf).
func TestAPersonsCRLFIsOneLineBreakInAPaste(t *testing.T) {
	assert.Equal(t, "one\ntwo\nthree", personLineBreaks("one\r\ntwo\r\nthree"))
	assert.Equal(t, "one\ntwo\n", personLineBreaks("one\r\ntwo\r\n"))
	assert.Equal(t, "alpha\nbeta", personLineBreaks("alpha\nbeta"), "an LF text is as it was")
	assert.Equal(t, "ls\r", personLineBreaks("ls\r"), "an Enter is not a line break")
	assert.Equal(t, "plain", personLineBreaks("plain"))
}
