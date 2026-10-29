package tracking

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11109 (Pi parity row 18): Pi is a provider of its own in the closed analytics sets, where it was counted as "other": the launch provider, the first agent reply's provider and the prerequisite tool.
func TestPiIsAProviderOfItsOwn(t *testing.T) {
	assert.Equal(t, "pi", ProviderFor("pi"))
	assert.Equal(t, "pi", ProviderFor(" Pi "))
	assert.Equal(t, "other", ProviderFor("antigravity"), "the closed set is still closed")
	assert.Equal(t, "pi", TeamProvider([]string{"pi", "pi"}))
	assert.Equal(t, "mixed", TeamProvider([]string{"pi", "claude"}))

	rec, _ := newTestTracking(t)
	TrackFirstAgentReply("pi", 9*time.Second, ReplyOK)
	waitForAsync()
	require.Equal(t, 1, rec.count(EventFirstAgentReply), rec.names())
	assert.Equal(t, "pi", rec.all()[0].Properties["provider"], "a Pi reply is reported as pi, not other")
}

func TestPiIsAPrerequisiteTool(t *testing.T) {
	rec, _ := newTestTracking(t)
	TrackPrerequisite(ToolPi, PrereqAvailable, SourceCLICheck)
	waitForAsync()
	require.Equal(t, 1, rec.count(EventPrerequisiteCheck), "the closed tool set takes pi: %v", rec.names())
	assert.Equal(t, "pi", rec.all()[0].Properties["tool"])
}
