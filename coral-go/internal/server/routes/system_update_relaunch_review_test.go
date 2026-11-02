package routes

import (
	"encoding/hex"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/secrets"
)

// #5290: a tunneled reply passes through the redactors, and a value under a key named for a token is taken as a secret. The acknowledgement
// is under "ack" so it reaches the hub whole; under "ack_token" the hub's redactor replaced it in every reply and no relaunch could work.
func TestTheAckReachesTheHubThroughTheRedactors(t *testing.T) {
	require.NoError(t, secrets.Init())
	e := newRelaunchEnv(t)
	pinAckInputs(t, e) // the key and the nonces are fixed: the same tokens every run, so a redactor that mistook a random one for a secret could not make this fail now and then (#12094)
	for i := 0; i < 20; i++ {
		_, st := e.status(hubHdr(ownerA))
		body, err := json.Marshal(st)
		require.NoError(t, err)
		ack := st["relaunch"].(map[string]any)["ack"].(string)
		for name, red := range map[string]func([]byte) ([]byte, error){
			"base": secrets.Redactor().Text,
			"hub":  secrets.HubRedactor(func() bool { return true }).Text,
		} {
			out, err := red(body)
			require.NoError(t, err)
			assert.Equal(t, string(body), string(out), "the %s redactor left the status as it was", name)
			assert.Contains(t, string(out), ack, name)
		}
	}
	// And the body a hub sends back is accepted as the status gave it.
	tok := e.token(ownerA)
	code, out := e.post(`{"ack":"`+tok+`"}`, hubHdr(ownerA))
	assert.Equal(t, 202, code, "%v", out)
	// The old name is not read: an extra field is a 400.
	code, _ = e.post(`{"ack_token":"`+tok+`"}`, hubHdr(ownerA))
	assert.Equal(t, 400, code)
}

// Two first requests at once must not leave tokens that fail to verify: the key is made once.
func TestTheFirstAcknowledgementKeyIsMadeOnce(t *testing.T) {
	e := newRelaunchEnv(t)
	toks := make([]string, 20)
	var wg sync.WaitGroup
	for i := range toks {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, st := e.status(hubHdr(ownerA))
			if rl, ok := st["relaunch"].(map[string]any); ok {
				toks[i], _ = rl["ack"].(string)
			}
		}(i)
	}
	wg.Wait()
	key, err := e.h.ackKey()
	require.NoError(t, err)
	for i, tk := range toks {
		require.NotEmpty(t, tk, i)
		_, ok := parseAck(key, callerIdentity{owner: true, pseudo: ownerA}, tk)
		assert.True(t, ok, "token %d verifies with the key on disk", i)
	}
}

// The once-per-version and spacing rules hold from this process's own memory even when the updater's record has not changed (a slow or
// faulty updater): a second valid token does not start a second relaunch.
func TestASecondTokenDoesNotStartASecondRelaunchWhateverTheUpdaterRecords(t *testing.T) {
	e := newRelaunchEnv(t)
	t1, t2 := e.token(ownerA), e.token(ownerA)
	code, _ := e.post(`{"ack":"`+t1+`"}`, hubHdr(ownerA))
	require.Equal(t, 202, code)
	code, out := e.post(`{"ack":"`+t2+`"}`, hubHdr(ownerA))
	assert.Equal(t, 409, code, "%v", out)
	assert.Equal(t, "already_relaunched", out["code"])
	assert.Equal(t, 1, e.up.applyCount())
	// A newer staged version is a new relaunch, but not inside the spacing.
	e.up.mu.Lock()
	e.up.rec.Staged.Version = "1.4.132"
	e.up.mu.Unlock()
	t3 := e.token(ownerA)
	code, out = e.post(`{"ack":"`+t3+`"}`, hubHdr(ownerA))
	assert.Equal(t, 429, code, "%v", out)
	assert.Equal(t, 1, e.up.applyCount())
	e.now = e.now.Add(relaunchSpacing + 1)
	t4 := e.token(ownerA)
	code, _ = e.post(`{"ack":"`+t4+`"}`, hubHdr(ownerA))
	assert.Equal(t, 202, code)
	assert.Equal(t, 2, e.up.applyCount())
	assert.False(t, strings.Contains(t4, " "))
}

// pinAckInputs fixes the two random inputs of an acknowledgement token: the key (written to the file the handler reads it from) and the nonce (a counter).
func pinAckInputs(t *testing.T, e *relaunchEnv) {
	t.Helper()
	require.NoError(t, e.h.ensureDir())
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(0x40 + i*7)
	}
	require.NoError(t, e.h.writePrivate(ackKeyFile, []byte(hex.EncodeToString(key))))
	n := 0
	e.h.nonceRead = func(b []byte) (int, error) {
		n++
		for i := range b {
			b[i] = byte(n*31 + i*13)
		}
		return len(b), nil
	}
}
