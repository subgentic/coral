package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type written struct{ dir, remote, secret string }

// The command's own job: read {remote, secret} from stdin, strictly, and hand it to the writer with the data folder. What the file holds and how it is made is pkg/hubowner's.
func TestHubOwnerSecretReadsStdinOnlyAndStrictly(t *testing.T) {
	var got []written
	write := func(d, r, s string) error { got = append(got, written{d, r, s}); return nil }
	secret := strings.Repeat("ab", 32)
	good := `{"remote":"ssh-box","secret":"` + secret + `"}`
	var out, errb bytes.Buffer

	assert.Equal(t, 2, runHubOwnerSecret([]string{"ssh-box"}, strings.NewReader(good), &out, &errb, write), "a positional argument")
	assert.Equal(t, 2, runHubOwnerSecret([]string{"--secret", secret}, strings.NewReader(good), &out, &errb, write), "the secret in argv")
	for name, in := range map[string]string{
		"empty":         "",
		"not json":      "ssh-box",
		"extra field":   `{"remote":"ssh-box","secret":"` + secret + `","replace":true}`,
		"two documents": good + good,
		"too long":      good + strings.Repeat(" ", 2000),
	} {
		out.Reset()
		errb.Reset()
		assert.Equal(t, 2, runHubOwnerSecret(nil, strings.NewReader(in), &out, &errb, write), name)
		assert.Empty(t, out.String(), name)
	}
	assert.Empty(t, got, "a refused input reached the writer")

	deny := func(string, string, string) error { return errors.New("not a valid secret") }
	out.Reset()
	errb.Reset()
	assert.Equal(t, 1, runHubOwnerSecret(nil, strings.NewReader(good), &out, &errb, deny))
	assert.Contains(t, errb.String(), "refused")
	assert.NotContains(t, errb.String(), secret, "the secret is never echoed")

	out.Reset()
	errb.Reset()
	require.Equal(t, 0, runHubOwnerSecret([]string{"--home", "/some/data"}, strings.NewReader(good), &out, &errb, write), errb.String())
	require.Len(t, got, 1)
	assert.Equal(t, "ssh-box", got[0].remote)
	assert.Equal(t, secret, got[0].secret)
	assert.Contains(t, got[0].dir, "/some/data")
	assert.NotContains(t, out.String(), secret)
}

func TestHubOwnerSecretIsNotInTheHelp(t *testing.T) {
	for _, c := range commands() {
		assert.NotEqual(t, "hub-owner-secret", c.name)
	}
}
