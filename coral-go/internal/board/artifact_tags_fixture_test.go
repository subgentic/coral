package board

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #8673 (Goal #61): the tag rules are in two places, here and in the dashboard's artifact_tag_rules.js. One JSON table of cases is read by both tests, so the client and the server cannot drift.
type artifactTagCases struct {
	MaxLen  int `json:"max_len"`
	MaxTags int `json:"max_tags"`
	Tags    []struct {
		Input string `json:"input"`
		Want  string `json:"want"`
		Note  string `json:"note"`
	} `json:"tags"`
	Sets []struct {
		Tags []string  `json:"tags"`
		Want *[]string `json:"want"`
		Note string    `json:"note"`
	} `json:"sets"`
}

func loadArtifactTagCases(t *testing.T) artifactTagCases {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "tests", "frontend", "fixtures", "artifact_tag_cases.json"))
	require.NoError(t, err)
	var c artifactTagCases
	require.NoError(t, json.Unmarshal(raw, &c))
	require.NotEmpty(t, c.Tags, "an empty table pins nothing")
	require.NotEmpty(t, c.Sets)
	return c
}

func TestArtifactTagRulesMatchTheSharedTable(t *testing.T) {
	c := loadArtifactTagCases(t)
	assert.Equal(t, MaxArtifactTagLen, c.MaxLen)
	assert.Equal(t, MaxArtifactTags, c.MaxTags)
	for _, tc := range c.Tags {
		got, ok := NormalizeArtifactTag(tc.Input)
		assert.Equal(t, tc.Want != "", ok, "%q (%s)", tc.Input, tc.Note)
		assert.Equal(t, tc.Want, got, "%q (%s)", tc.Input, tc.Note)
	}
	for _, tc := range c.Sets {
		got, err := NormalizeArtifactTags(tc.Tags)
		if tc.Want == nil {
			assert.ErrorIs(t, err, ErrArtifactTag, "%q (%s)", tc.Tags, tc.Note)
			continue
		}
		require.NoError(t, err, "%q (%s)", tc.Tags, tc.Note)
		assert.Equal(t, *tc.Want, got, "%q (%s)", tc.Tags, tc.Note)
	}
}
