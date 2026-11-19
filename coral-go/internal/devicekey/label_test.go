package devicekey_test

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/devicekey"
)

type labelCase struct {
	Note     string `json:"note"`
	LabelHex string `json:"label_hex"`
	OK       bool   `json:"ok"`
}

// The shared table (docs/design/device-keys-label-cases.json on the Hub side): one row per class. The Hub's test and the browser page's test read the same file; where a JS trim and a Go TrimSpace differ, the table decides.
func TestLabelCasesTable(t *testing.T) {
	b, err := os.ReadFile("testdata/device-keys-label-cases.json")
	require.NoError(t, err)
	var cases []labelCase
	require.NoError(t, json.Unmarshal(b, &cases))
	require.GreaterOrEqual(t, len(cases), 30)
	seen := map[string]bool{}
	for _, c := range cases {
		raw, err := hex.DecodeString(c.LabelHex)
		require.NoError(t, err, c.Note)
		assert.Equal(t, c.OK, devicekey.LabelOK(string(raw)), c.Note)
		seen[c.Note] = true
	}
	for _, need := range []string{"Cc tab", "Cc newline", "Cc DEL", "Cc U+0085", "Cf zero width space", "Cf U+FEFF", "Cf U+202E", "Zl U+2028", "Zp U+2029", "Co U+E000", "Cs surrogate bytes", "U+FFFD", "invalid UTF-8", "empty", "64 bytes", "65 bytes",
		"NBSP inside", "NBSP at start", "ideographic space at end", "leading space", "trailing space", "NFKC ligature fi", "NFKC fullwidth A", "plain ascii", "plain unicode"} {
		assert.True(t, seen[need], "the table has a row for %q", need)
	}
}

func TestCleanLabelIsNFKCThenTrimSpace(t *testing.T) {
	assert.Equal(t, "fi", devicekey.CleanLabel("ﬁ"))
	assert.Equal(t, "A", devicekey.CleanLabel(" 　 Ａ  "))
	assert.Equal(t, "My laptop", devicekey.CleanLabel("My laptop"))
}

func TestLabelLimitIsBytesNotRunes(t *testing.T) {
	assert.True(t, devicekey.LabelOK(strings.Repeat("a", 64)))
	assert.False(t, devicekey.LabelOK(strings.Repeat("a", 65)))
	assert.True(t, devicekey.LabelOK(strings.Repeat("é", 32)), "32 two-byte runes is 64 bytes")
	assert.False(t, devicekey.LabelOK(strings.Repeat("é", 33)))
}
