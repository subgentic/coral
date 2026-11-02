package machinelaunch

import (
	"bytes"
	"strings"
	"testing"
)

// The machine's `coral cloud status` answer is kept up to 64 KB and no more (coral-go Security's INFO): a machine that answers without end cannot grow the launcher's memory, and the session is not stopped.
func TestCapBufferKeepsOnlyTheCap(t *testing.T) {
	c := &capBuffer{max: statusMaxBytes}
	chunk := []byte(strings.Repeat("x", 10_000))
	for i := 0; i < 100; i++ {
		if n, err := c.Write(chunk); n != len(chunk) || err != nil {
			t.Fatalf("write %d: %d, %v (it reports every byte written)", i, n, err)
		}
	}
	if got := len(c.String()); got != statusMaxBytes {
		t.Fatalf("kept %d bytes, want %d", got, statusMaxBytes)
	}
	small := &capBuffer{max: 10}
	small.Write([]byte("0123456"))
	small.Write([]byte("789abcdef"))
	if small.String() != "0123456789" {
		t.Fatalf("kept %q", small.String())
	}
	var _ = bytes.Buffer{}
}
