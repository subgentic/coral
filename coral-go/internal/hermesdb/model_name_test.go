package hermesdb

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestModelNameOKIsLettersDigitsAndAFewMarksOnly(t *testing.T) {
	for _, ok := range []string{"gpt-4o", "provider/vendor-model_1.2:tag@x+y", strings.Repeat("x", ModelNameMax)} {
		assert.True(t, ModelNameOK(ok), ok)
	}
	for _, bad := range []string{"", "two words", "<b>", "a​b", "a‮b", "a\x1b[0m", "a\nb", "é", `a\b`, "a;b", strings.Repeat("x", ModelNameMax+1)} {
		assert.False(t, ModelNameOK(bad), "%q", bad)
	}
}
