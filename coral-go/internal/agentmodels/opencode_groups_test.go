package agentmodels

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestOpencodeModelsAreGroupedByProviderTheSignedInOnesFirst(t *testing.T) {
	s := NewService(nil)
	s.opencodeSignedIn = func(context.Context, string) map[string]bool { return map[string]bool{"githubcopilot": true} }
	models := []Model{{Value: "openai/gpt-6", Group: "openai"}, {Value: "github-copilot/x", Group: "github-copilot"}, {Value: "openai/gpt-5", Group: "openai"}, {Value: "opencode/big-pickle", Group: "opencode"}}
	got := s.opencodeGroups(models, "/bin/opencode")
	assert.Equal(t, []Group{{Name: "github-copilot", SignedIn: true}, {Name: "openai"}, {Name: "opencode"}}, got)

	s.opencodeSignedIn = func(context.Context, string) map[string]bool { return nil }
	got = s.opencodeGroups(models, "/bin/opencode")
	assert.Equal(t, []Group{{Name: "openai"}, {Name: "github-copilot"}, {Name: "opencode"}}, got, "when opencode cannot say, every provider is listed and none is marked")
}

func TestTheModelsAnswerForOpencodeCarriesItsGroupsAndNoDefaultOfCorals(t *testing.T) {
	s, _ := newTestService(t, fakeCLI(t), func(context.Context, string, string) ([]Model, string, error) {
		return []Model{{Value: "openai/gpt-6", DisplayName: "gpt-6", Group: "openai"}, {Value: "opencode/big-pickle", DisplayName: "big-pickle", Group: "opencode"}}, "account", nil
	})
	s.opencodeSignedIn = func(context.Context, string) map[string]bool { return map[string]bool{"opencode": true} }
	s.Get("opencode")
	s.Wait()
	r := s.Get("opencode")
	assert.Equal(t, []Group{{Name: "opencode", SignedIn: true}, {Name: "openai"}}, r.Groups)
	assert.Empty(t, r.DefaultModel, "opencode keeps its own default model")
	assert.Equal(t, "opencode/big-pickle", r.Models[1].Value)
}

// opencode has no thinking levels here: on 1.19.5 a "#variant" in the config's model is dropped (`opencode debug config` resolves "openai/gpt-5#high" to "openai/gpt-5"), so no effort control is offered until the server or the
// attach honours one (#137997). The card says so.
func TestOpencodeOffersNoThinkingLevels(t *testing.T) {
	assert.Empty(t, ThinkingLevels("opencode"))
	assert.False(t, ValidThinking("opencode", "high"))
	assert.True(t, ValidThinking("opencode", ""), "the CLI's own default is always valid")
	s, _ := newTestService(t, fakeCLI(t), func(context.Context, string, string) ([]Model, string, error) {
		return []Model{{Value: "openai/gpt-6", DisplayName: "gpt-6", Group: "openai"}}, "account", nil
	})
	s.opencodeSignedIn = func(context.Context, string) map[string]bool { return nil }
	s.Get("opencode")
	s.Wait()
	assert.Empty(t, s.Get("opencode").Thinking)
}
