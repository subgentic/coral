package devicekey_test

import (
	"errors"
	"os"
	"regexp"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/devicekey"
)

// coral-hub's final rule for slice 7 (c): one closed list of reply codes, shared by the verifier tests and the Hub's reply cut, so a code added on either side fails a test.

var errNameRe = regexp.MustCompile(`Err\w+\s*=\s*errors\.New\("([a-z_]+)"\)`)

func TestEveryVerifierCodeIsInTheClosedReplyListOrFolded(t *testing.T) {
	seen := map[string]bool{}
	for _, f := range []string{"verify.go", "message.go", "passkey.go"} { // the signed-message path; pairing.go's codes are the pairing's own
		b, err := os.ReadFile(f)
		require.NoError(t, err)
		for _, m := range errNameRe.FindAllStringSubmatch(string(b), -1) {
			seen[m[1]] = true
			assert.True(t, devicekey.InReplyCodes(m[1]) || devicekey.FoldedCodes[m[1]], "%s is a new code: add it to ReplyCodes (and tell coral-hub) or fold it into bad_signature", m[1])
		}
	}
	require.NotEmpty(t, seen)
	for _, c := range devicekey.ReplyCodes {
		if c != devicekey.CodeInternal {
			assert.True(t, seen[c], "%s is in ReplyCodes but no verifier error has it", c)
		}
	}
}

func TestReplyCodeOfAnErrorIsAlwaysInTheClosedList(t *testing.T) {
	for _, err := range []error{
		devicekey.ErrBadForm, devicekey.ErrWrongComputer, devicekey.ErrUnknownSigner, devicekey.ErrSignerRemoved, devicekey.ErrBadSignature,
		devicekey.ErrSignerBootstrap, devicekey.ErrSignerNoProof, devicekey.ErrBadMode, devicekey.ErrTopMode, devicekey.ErrAboveSigner, devicekey.ErrSelfTarget,
		devicekey.ErrTargetBootstrap, devicekey.ErrUnknownTarget, devicekey.ErrNonceRepeat, devicekey.ErrNonceStoreFull, devicekey.ErrKeyLimit,
		devicekey.ErrTsWindow, devicekey.ErrBeforeStart, devicekey.ErrClockBack, devicekey.ErrListUnavailable, errors.New("disk is full"), nil,
	} {
		if err == nil {
			continue
		}
		assert.True(t, devicekey.InReplyCodes(devicekey.ReplyCode(err)), "%v", err)
	}
	for _, e := range []error{devicekey.ErrUnknownSigner, devicekey.ErrSignerRemoved, devicekey.ErrWrongComputer} {
		assert.Equal(t, "bad_signature", devicekey.ReplyCode(e), "a signer that is not listed, was removed, or a computer that is not this one is not told apart from a bad signature")
	}
	assert.Equal(t, devicekey.CodeInternal, devicekey.ReplyCode(errors.New("disk is full")), "an unexpected error says nothing of itself")
}
