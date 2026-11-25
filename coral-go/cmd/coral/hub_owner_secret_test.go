package main

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agentenv"
	"github.com/subgentic/coral/pkg/hubowner"
)

type written struct{ dir, remote, secret string }

// The command's own job: read {remote, secret} from stdin, strictly, and hand it to the writer with the data folder. What the file holds and how it is made is pkg/hubowner's.
func TestHubOwnerSecretReadsStdinOnlyAndStrictly(t *testing.T) {
	noAgentEnv(t)
	var got []written
	write := func(d, r, s string) error { got = append(got, written{d, r, s}); return nil }
	secret := strings.Repeat("ab", 32)
	good := `{"remote":"ssh-box","secret":"` + secret + `"}`
	var out, errb bytes.Buffer

	assert.Equal(t, 2, runOwnerSecret3([]string{"ssh-box"}, strings.NewReader(good), &out, &errb, write, noTerminal), "a positional argument")
	assert.Equal(t, 2, runOwnerSecret3([]string{"--secret", secret}, strings.NewReader(good), &out, &errb, write, noTerminal), "the secret in argv")
	for name, in := range map[string]string{
		"empty":         "",
		"not json":      "ssh-box",
		"extra field":   `{"remote":"ssh-box","secret":"` + secret + `","replace":true}`,
		"two documents": good + good,
		"too long":      good + strings.Repeat(" ", 2000),
	} {
		out.Reset()
		errb.Reset()
		assert.Equal(t, 2, runOwnerSecret3(nil, strings.NewReader(in), &out, &errb, write, noTerminal), name)
		assert.Empty(t, out.String(), name)
	}
	assert.Empty(t, got, "a refused input reached the writer")

	deny := func(string, string, string) error { return errors.New("not a valid secret") }
	out.Reset()
	errb.Reset()
	assert.Equal(t, 1, runOwnerSecret3(nil, strings.NewReader(good), &out, &errb, deny, noTerminal))
	assert.Contains(t, errb.String(), "refused")
	assert.NotContains(t, errb.String(), secret, "the secret is never echoed")

	out.Reset()
	errb.Reset()
	require.Equal(t, 0, runOwnerSecret3([]string{"--home", "/some/data"}, strings.NewReader(good), &out, &errb, write, noTerminal), errb.String())
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

// runOwnerSecret3 runs the command with a writer that takes the id and the secret only: what these tests of the reading look at.
func runOwnerSecret3(args []string, stdin io.Reader, stdout, stderr io.Writer, write func(dir, remote, secret string) error, ask func(string, io.Writer) (string, bool, error)) int {
	return runHubOwnerSecretWith(args, stdin, stdout, stderr, func(dir string, l hubowner.Link) error { return write(dir, l.Remote, l.Secret) }, ask)
}

func noTerminal(string, io.Writer) (string, bool, error) { return "", false, nil }

func atTerminal(line string) func(string, io.Writer) (string, bool, error) {
	return func(string, io.Writer) (string, bool, error) { return line, true, nil }
}

// At a terminal the person pastes the hub's setup line (not echoed); it is read the same strict way, and nothing is taken from stdin.
func TestHubOwnerSecretAtATerminalTakesTheHubsSetupLine(t *testing.T) {
	noAgentEnv(t)
	var got []written
	write := func(d, r, s string) error { got = append(got, written{d, r, s}); return nil }
	secret := strings.Repeat("cd", 32)
	var out, errb bytes.Buffer

	require.Equal(t, 0, runOwnerSecret3([]string{"--home", "/some/data"}, strings.NewReader("ignored"), &out, &errb, write, atTerminal("web "+secret)), errb.String())
	require.Len(t, got, 1)
	assert.Equal(t, written{got[0].dir, "web", secret}, got[0])
	assert.Contains(t, got[0].dir, "/some/data")
	assert.NotContains(t, out.String()+errb.String(), secret, "the secret is never echoed")

	for name, line := range map[string]string{
		"empty":       "",
		"one word":    "web",
		"three words": "web " + secret + " extra",
		"too long":    "web " + strings.Repeat("a", 2000),
	} {
		got = nil
		out.Reset()
		errb.Reset()
		assert.Equal(t, 2, runOwnerSecret3(nil, strings.NewReader(""), &out, &errb, write, atTerminal(line)), name)
		assert.Empty(t, got, name+": a bad line reached the writer")
	}
	// a terminal that cannot be read from
	failing := func(string, io.Writer) (string, bool, error) { return "", true, errors.New("read error") }
	assert.Equal(t, 2, runOwnerSecret3(nil, strings.NewReader(""), &out, &errb, write, failing))
	// the writer's refusal is the command's
	deny := func(string, string, string) error { return errors.New("not a valid secret") }
	errb.Reset()
	assert.Equal(t, 1, runOwnerSecret3(nil, strings.NewReader(""), &out, &errb, deny, atTerminal("web "+secret)))
	assert.NotContains(t, errb.String(), secret)
}

// The person's act: inside an agent's session (any of its identity variables) the command refuses before it reads anything or writes anything (#11378, Security's SHOULD 1).
func TestHubOwnerSecretRefusesInsideAnAgentsSession(t *testing.T) {
	secret := strings.Repeat("ef", 32)
	good := `{"remote":"ssh-box","secret":"` + secret + `"}`
	for _, v := range agentenv.IdentityVars {
		var wrote bool
		write := func(string, string, string) error { wrote = true; return nil }
		var out, errb bytes.Buffer
		t.Setenv(v, "something")
		assert.Equal(t, 1, runOwnerSecret3(nil, strings.NewReader(good), &out, &errb, write, noTerminal), v)
		assert.False(t, wrote, v+": the secret was written from an agent's session")
		assert.Contains(t, errb.String(), "the person's act", v)
		assert.NotContains(t, errb.String(), secret, v)
		t.Setenv(v, "")
	}
	// without any of them it runs
	noAgentEnv(t)
	var wrote bool
	assert.Equal(t, 0, runOwnerSecret3(nil, strings.NewReader(good), &bytes.Buffer{}, &bytes.Buffer{}, func(string, string, string) error { wrote = true; return nil }, noTerminal))
	assert.True(t, wrote)
}

// noAgentEnv clears an agent's identity variables for a test of the person's side (a test run from an agent's own shell inherits them).
func noAgentEnv(t *testing.T) {
	t.Helper()
	for _, v := range agentenv.IdentityVars {
		t.Setenv(v, "")
	}
}

// #21213: a newer hub names itself (its hub id, and its name over SSH), so its secret is kept beside other hubs'; the person can list the hubs (never a secret) and remove one.
func TestHubOwnerSecretTakesTheHubsIDAndListsAndRemovesLinks(t *testing.T) {
	noAgentEnv(t)
	hub := strings.Repeat("a", 32)
	secret := strings.Repeat("ab", 32)
	var got []hubowner.Link
	write := func(_ string, l hubowner.Link) error { got = append(got, l); return nil }
	var out, errb bytes.Buffer

	require.Equal(t, 0, runHubOwnerSecretWith(nil, strings.NewReader(`{"remote":"mac","secret":"`+secret+`","hub":"`+hub+`","name":"Studio hub"}`), &out, &errb, write, noTerminal), errb.String())
	require.Equal(t, 0, runHubOwnerSecretWith(nil, strings.NewReader(""), &out, &errb, write, atTerminal("mac "+secret+" "+hub)), errb.String())
	require.Len(t, got, 2)
	assert.Equal(t, hubowner.Link{Hub: hub, Name: "Studio hub", Remote: "mac", Secret: secret}, got[0])
	assert.Equal(t, hubowner.Link{Hub: hub, Remote: "mac", Secret: secret}, got[1])
	got = nil
	assert.Equal(t, 2, runHubOwnerSecretWith(nil, strings.NewReader(`{"remote":"mac","secret":"`+secret+`","hub":"NOT AN ID"}`), &out, &errb, write, noTerminal))
	assert.Equal(t, 2, runHubOwnerSecretWith(nil, strings.NewReader(""), &out, &errb, write, atTerminal("mac "+secret+" short")))
	assert.Empty(t, got)

	dir := t.TempDir()
	require.NoError(t, hubowner.Install(dir, hubowner.Link{Hub: hub, Name: "Studio hub", Remote: "mac", Secret: secret}, time.Now()))
	require.NoError(t, hubowner.WriteFile(dir, "ssh-box", strings.Repeat("cd", 32)))
	out.Reset()
	require.Equal(t, 0, runHubOwnerSecretWith([]string{"--home", dir, "--list"}, strings.NewReader(""), &out, &errb, write, noTerminal), errb.String())
	assert.Contains(t, out.String(), "Studio hub")
	assert.Contains(t, out.String(), "ssh-box")
	assert.NotContains(t, out.String(), secret)
	assert.NotContains(t, out.String(), strings.Repeat("cd", 32))

	out.Reset()
	require.Equal(t, 0, runHubOwnerSecretWith([]string{"--home", dir, "--remove", hub}, strings.NewReader(""), &out, &errb, write, noTerminal), errb.String())
	assert.Equal(t, 1, runHubOwnerSecretWith([]string{"--home", dir, "--remove", hub}, strings.NewReader(""), &out, &errb, write, noTerminal), "already gone")
	ls, err := hubowner.Links(dir)
	require.NoError(t, err)
	require.Len(t, ls, 1)
	assert.Equal(t, "ssh-box", ls[0].Remote)
	assert.Equal(t, 2, runHubOwnerSecretWith([]string{"--home", dir, "--list", "--remove", hub}, strings.NewReader(""), &out, &errb, write, noTerminal), "one or the other")
}

// #21251: --list flags a leftover single-file secret under a link's computer name, with the line to remove it, and flags nothing else.
func TestHubOwnerSecretListFlagsALeftoverSingleFile(t *testing.T) {
	noAgentEnv(t)
	hub := strings.Repeat("a", 32)
	write := func(string, hubowner.Link) error { return nil }
	dir := t.TempDir()
	var out, errb bytes.Buffer
	list := func() string {
		out.Reset()
		require.Equal(t, 0, runHubOwnerSecretWith([]string{"--home", dir, "--list"}, strings.NewReader(""), &out, &errb, write, noTerminal), errb.String())
		return out.String()
	}
	require.NoError(t, hubowner.WriteFile(dir, "mac", strings.Repeat("cd", 32)))
	assert.NotContains(t, list(), "leftover", "a single file alone")
	require.NoError(t, hubowner.Install(dir, hubowner.Link{Hub: hub, Name: "Studio hub", Remote: "mac", Secret: strings.Repeat("ab", 32)}, time.Now()))
	got := list()
	assert.Contains(t, got, "leftover")
	assert.Contains(t, got, "coral hub-owner-secret --remove mac")
	assert.NotContains(t, got, strings.Repeat("cd", 32))
	assert.NotContains(t, got, strings.Repeat("ab", 32))
	assert.Equal(t, 1, strings.Count(got, "leftover"), "only the single file's line")
}
