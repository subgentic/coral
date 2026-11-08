package agent

import (
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #14772: agy's Don't ask is Plan everywhere. The launch types '--mode plan' (appendAgyPermissionMode); the flags the launch records for a mode (PermissionFlagsForAgent) said none, so the two disagreed.
func TestAgyPermissionFlagsForAModeAreWhatTheLaunchTypes(t *testing.T) {
	withAgyHelp(t, agyHelpWithAuto)
	permFlags := regexp.MustCompile(`--mode [a-z-]+|--dangerously-skip-permissions`)
	for _, typ := range []string{"agy", "antigravity", "gemini"} {
		for _, mode := range []string{"default", "plan", "acceptEdits", "bypassPermissions", "dontAsk"} {
			want := strings.Join(PermissionFlagsForAgent(typ, mode), " ")
			got := strings.Join(permFlags.FindAllString(buildLaunch(&AgyAgent{}, LaunchParams{PermissionMode: mode}), -1), " ")
			assert.Equal(t, want, got, typ+" "+mode+": the recorded flags are what the command carries")
		}
	}
	assert.Equal(t, []string{"--mode", "plan"}, PermissionFlagsForAgent("agy", "dontAsk"), "Don't ask is Plan")
	assert.Nil(t, PermissionFlagsForAgent("agy", "auto"), "auto is added by the launch builder, once agy is asked whether it lists it")
}
