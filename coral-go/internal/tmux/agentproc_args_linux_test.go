//go:build linux

package tmux

import (
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestProgramArgsReadsTheArgumentVectorExactly(t *testing.T) {
	args := ProgramArgs(os.Getpid())
	if assert.NotEmpty(t, args) {
		assert.Equal(t, os.Args, args, "NUL-separated, so an argument with a space is one argument")
	}
	assert.Nil(t, ProgramArgs(0x7ffffff0), "a process that is not there")
}
