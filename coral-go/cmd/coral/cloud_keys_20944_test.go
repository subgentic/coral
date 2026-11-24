package main

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func runKeys(t *testing.T, f *fakeCoral, args ...string) (int, string, string) {
	t.Helper()
	var out, errb bytes.Buffer
	code := runCloud(append(append([]string{"keys"}, args...), "--url", f.srv.URL), nil, &out, &errb)
	return code, out.String(), errb.String()
}

// #20944: `coral cloud keys create <name>` is how a self-hosted Hub, over SSH, gets its request key: the key alone on stdout (so a script can keep it), the words on stderr, and nothing of the key ever in a list.
func TestKeysCreatePrintsTheKeyAloneOnStdout(t *testing.T) {
	f := newFakeCoral(t, ready, enrolled)
	f.keyReply = `{"id":"lk-0a1b2c3d","name":"Hub C","key":"lrk_0a1b2c3d_00112233445566778899aabbccddeeff"}`
	code, out, errb := runKeys(t, f, "create", "Hub C")
	require.Equal(t, 0, code, errb)
	assert.Equal(t, "lrk_0a1b2c3d_00112233445566778899aabbccddeeff\n", out)
	assert.Contains(t, errb, "shown once")
	assert.NotContains(t, errb, "lrk_")
	assert.Equal(t, []string{`POST /api/cloud/link-keys {"name":"Hub C"}`}, mutating(f))
}

func TestKeysListAndRevokeAndNeverGuess(t *testing.T) {
	f := newFakeCoral(t, ready, enrolled)
	f.keyReply = `{"keys":[{"id":"lk-0a1b2c3d","name":"Hub\u001b[31m C","created_at":"2026-11-24T12:00:00Z","last_used_at":"2026-11-24T13:00:00Z"}]}`
	code, out, _ := runKeys(t, f, "list")
	require.Equal(t, 0, code, out)
	assert.Contains(t, out, "lk-0a1b2c3d")
	assert.NotContains(t, out, "\x1b")
	assert.NotContains(t, out, "lrk_")
	f2 := newFakeCoral(t, ready, enrolled)
	f2.keyReply = `{"ok":true}`
	code, out, _ = runKeys(t, f2, "revoke", "lk-0a1b2c3d")
	require.Equal(t, 0, code, out)
	assert.Equal(t, []string{`DELETE /api/cloud/link-keys/lk-0a1b2c3d`}, mutating(f2))
	for _, bad := range [][]string{{"create"}, {"create", "a", "b"}, {"revoke"}, {"nope"}} {
		g := newFakeCoral(t, ready, enrolled)
		g.keyReply = `{}`
		code, _, errb := runKeys(t, g, bad...)
		assert.Equal(t, 2, code, "%v", bad)
		assert.Contains(t, errb, "usage:")
		assert.Empty(t, mutating(g))
	}
}
