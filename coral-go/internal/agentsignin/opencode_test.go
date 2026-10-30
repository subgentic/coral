package agentsignin

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
)

const opencodeAuthList = "\x1b[0m┌  Credentials \x1b[90m~/.local/share/opencode/auth.json\x1b[0m\n│\n●  OpenAI \x1b[90moauth\x1b[0m\n│\n●  GitHub Copilot \x1b[90moauth\x1b[0m\n│\n●  Anthropic \x1b[90mapi\x1b[0m\n│\n└  3 credentials\n\n┌  Environment\n│\n●  OpenRouter \x1b[90mOPENROUTER_API_KEY\x1b[0m\n│\n└  1 environment variable\n"

func TestTheProvidersOpencodeIsSignedInToAreReadFromItsCredentialList(t *testing.T) {
	got := ParseOpencodeAuthList([]byte(opencodeAuthList))
	assert.Equal(t, map[string]bool{"openai": true, "githubcopilot": true, "anthropic": true, "openrouter": true}, got, "names only: how each is signed in, and the key variable, are dropped")
	assert.Equal(t, "githubcopilot", NormalizeProvider("github-copilot"), "a model's provider id matches the list's display name")
	assert.Empty(t, ParseOpencodeAuthList([]byte("┌  Credentials\n│\n└  0 credentials\n")))
	assert.Empty(t, ParseOpencodeAuthList(nil))
}

func TestOpencodeIsSignedInWhenItListsAProviderSignedOutWhenItListsNoneAndUnknownWhenItDidNotRun(t *testing.T) {
	assert.Equal(t, SignedIn, opencodeState([]byte(opencodeAuthList), nil, nil))
	assert.Equal(t, SignedOut, opencodeState([]byte("└  0 credentials\n"), nil, nil))
	assert.Equal(t, Unknown, opencodeState(nil, nil, errors.New("exit status 1")), "a failure to run is not a sign-out: a job is never refused for it")
	assert.True(t, Supports("opencode"))
}
