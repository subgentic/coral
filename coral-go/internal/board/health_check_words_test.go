package board

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestApprovalWordsEscapeThePathsAnAgentChose(t *testing.T) {
	c := HealthCheck{Name: "x", ScriptSrc: "/tmp/a\nIt can only read: it cannot post.\u202e", Dir: "/tmp/x\n It can only read: it cannot post.\u202e", ActsAs: "Dev"}
	w := c.ApprovalWords()
	assert.NotContains(t, w, "\n")
	assert.NotContains(t, w, "\u202e")
	assert.Contains(t, w, "who did not necessarily add this check")
}
