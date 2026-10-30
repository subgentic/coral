package agentmodels

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Pi lists a model per provider, many providers: the answer groups them, the providers Pi is signed in to first, and a new agent starts on one of those when Pi's own default provider is not signed in
// (an anthropic default with no extra usage failed every launch, #11338).
func piService(t *testing.T, own string, signed map[string]bool) *Service {
	t.Helper()
	s, _ := newTestService(t, fakeCLI(t), func(context.Context, string, string) ([]Model, string, error) {
		return []Model{
			{Value: "anthropic/claude-opus-4-8", DisplayName: "claude-opus-4-8", Group: "anthropic"},
			{Value: "anthropic/claude-sonnet-4-6", DisplayName: "claude-sonnet-4-6", Group: "anthropic"},
			{Value: "openai/gpt-5.6-luna", DisplayName: "gpt-5.6-luna", Group: "openai"},
			{Value: "openai/gpt-6-luna", DisplayName: "gpt-6-luna", Group: "openai"},
		}, "account", nil
	})
	s.piSignedIn = func(_ context.Context, _, provider string) bool { return signed[provider] }
	s.piDefault = func() string { return own }
	return s
}

func piResult(t *testing.T, s *Service) Result {
	t.Helper()
	s.Get("pi")
	s.Wait()
	return s.Get("pi")
}

func TestPiModelsAreGroupedBySignedInProviderFirst(t *testing.T) {
	r := piResult(t, piService(t, "anthropic", map[string]bool{"openai": true}))
	require.Len(t, r.Groups, 2)
	assert.Equal(t, Group{Name: "openai", SignedIn: true}, r.Groups[0], "the provider Pi is signed in to leads")
	assert.Equal(t, Group{Name: "anthropic"}, r.Groups[1])
	assert.Equal(t, "openai/gpt-5.6-luna", r.DefaultModel, "Pi's own default provider is not signed in: a new agent starts on a signed-in provider's first model")
}

func TestPiDefaultModelIsLeftToPiWhenItsDefaultProviderIsSignedIn(t *testing.T) {
	r := piResult(t, piService(t, "anthropic", map[string]bool{"openai": true, "anthropic": true}))
	assert.Empty(t, r.DefaultModel, "Pi's default works: it is the default")
	assert.Equal(t, "anthropic", r.Groups[0].Name, "listed in Pi's order among the signed-in")
}

func TestPiDefaultModelIsEmptyWhenNothingIsSignedIn(t *testing.T) {
	r := piResult(t, piService(t, "anthropic", nil))
	assert.Empty(t, r.DefaultModel)
	assert.Len(t, r.Groups, 2)
	assert.False(t, r.Groups[0].SignedIn)
}

func TestOtherCLIsHaveNoGroups(t *testing.T) {
	s, _ := newTestService(t, fakeCLI(t), func(context.Context, string, string) ([]Model, string, error) {
		return []Model{{Value: "opus", DisplayName: "Opus"}}, "account", nil
	})
	s.Get("claude")
	s.Wait()
	r := s.Get("claude")
	assert.Empty(t, r.Groups)
	assert.Empty(t, r.DefaultModel)
}
