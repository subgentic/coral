package executil

import (
	"bytes"
	"log"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #14064: the opener says whether it opened something, and a failure is logged without the link's query.
func TestTryOpenBrowserSaysWhetherAnythingOpenedAndLogsAFailure(t *testing.T) {
	var logs bytes.Buffer
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	old := startOpener
	t.Cleanup(func() { startOpener = old })

	var got [][]string
	startOpener = func(argv []string) bool { got = append(got, argv); return false }
	assert.False(t, TryOpenBrowser("http://127.0.0.1:8420/?login=SECRETVALUE"), "an opener that fails is a false")
	assert.Len(t, got, 1)
	assert.Contains(t, logs.String(), "the system's opener failed for http://127.0.0.1:8420/?...")
	assert.NotContains(t, logs.String(), "SECRETVALUE")

	logs.Reset()
	got = nil
	assert.False(t, TryOpenBrowser("file:///etc/passwd?x=SECRETVALUE"))
	assert.Empty(t, got, "a non-web address never reaches the opener")
	assert.Contains(t, logs.String(), "not a plain http or https address")
	assert.NotContains(t, logs.String(), "SECRETVALUE")

	startOpener = func(argv []string) bool { return true }
	assert.True(t, TryOpenBrowser("https://github.com/subgentic/coral/releases"))
}

func TestRedactForLogCutsTheQuery(t *testing.T) {
	assert.Equal(t, "http://127.0.0.1:8420/?...", redactForLog("http://127.0.0.1:8420/?login=abc"))
	assert.Equal(t, "http://h/p", redactForLog("http://h/p"))
}
