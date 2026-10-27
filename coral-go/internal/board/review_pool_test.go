package board

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #8957 (Goal #80): the vocabulary and the agent's own setting of the review pool.

func TestNormalizeReviewAreas(t *testing.T) {
	got, err := NormalizeReviewAreas([]string{" UI ", "go", "ui", "", "Security", "release-2"})
	require.NoError(t, err)
	assert.Equal(t, []string{"ui", "go", "security", "release-2"}, got, "lowercased, trimmed, each once, in the order given")
	got, err = NormalizeReviewAreas(nil)
	require.NoError(t, err)
	assert.NotNil(t, got)
	assert.Empty(t, got)
	for _, bad := range []string{"a b", "-ui", "9go", "ui!", "UI/go", "a_b", "é", "this-area-word-is-far-too-long"} {
		_, err := NormalizeReviewAreas([]string{"ok", bad})
		require.ErrorIs(t, err, ErrReviewArea, bad)
		assert.Contains(t, err.Error(), bad, "the refusal names the word")
	}
	many := []string{"a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"}
	_, err = NormalizeReviewAreas(many)
	require.ErrorIs(t, err, ErrReviewArea, "more than eight")
	got, err = NormalizeReviewAreas(many[:8])
	require.NoError(t, err)
	assert.Len(t, got, 8)
}

func TestAreasMatch(t *testing.T) {
	for _, c := range []struct {
		reviewer, review []string
		want             bool
	}{
		{nil, nil, true},
		{nil, []string{"ui"}, true}, // a reviewer who takes every area
		{[]string{"go"}, nil, true}, // a review with no area goes to any reviewer
		{[]string{"go", "ui"}, []string{"docs", "ui"}, true},
		{[]string{"go"}, []string{"ui"}, false},
		{[]string{"go", "security"}, []string{"ui", "docs"}, false},
	} {
		assert.Equal(t, c.want, AreasMatch(c.reviewer, c.review), "%v / %v", c.reviewer, c.review)
	}
}

func reviewPoolStore(t *testing.T) (*Store, context.Context) {
	t.Helper()
	ctx := context.Background()
	s := testStore(t)
	for _, m := range []struct{ name, role string }{{"Lead", "Orchestrator"}, {"Dev", "Developer"}, {"Rev", "Security Reviewer"}} {
		_, err := s.Subscribe(ctx, "team", m.name, m.role, "claude-"+m.name, nil, "all")
		require.NoError(t, err)
	}
	return s, ctx
}

func TestSetReviewSettingsChangesOnlyWhatIsSent(t *testing.T) {
	s, ctx := reviewPoolStore(t)
	sub, err := s.GetProjectSubscription(ctx, "team", "Rev")
	require.NoError(t, err)
	assert.False(t, sub.ReviewsOnly, "off by default")
	assert.Empty(t, sub.ReviewAreas.Slice(), "and every area")
	b, err := json.Marshal(sub)
	require.NoError(t, err)
	var shown map[string]any
	require.NoError(t, json.Unmarshal(b, &shown))
	assert.Equal(t, false, shown["reviews_only"])
	assert.Equal(t, []any{}, shown["review_areas"], "an empty array, never null")

	yes := true
	got, err := s.SetReviewSettings(ctx, "team", "Rev", &yes, nil)
	require.NoError(t, err)
	assert.Equal(t, &ReviewSettings{SubscriberID: "Rev", ReviewsOnly: true, ReviewAreas: []string{}}, got)
	areas := []string{"Security", "go", "go"}
	got, err = s.SetReviewSettings(ctx, "team", "Rev", nil, &areas)
	require.NoError(t, err)
	assert.Equal(t, []string{"security", "go"}, got.ReviewAreas, "normalised")
	assert.True(t, got.ReviewsOnly, "the switch kept what it was")

	sub, err = s.GetProjectSubscription(ctx, "team", "Rev")
	require.NoError(t, err)
	assert.True(t, sub.ReviewsOnly)
	assert.Equal(t, []string{"security", "go"}, sub.ReviewAreas.Slice())
	assert.True(t, s.IsReviewsOnly(ctx, "team", "Rev"))
	assert.False(t, s.IsReviewsOnly(ctx, "team", "Dev"), "another member is unchanged")

	// a re-subscribe (a restart) keeps the setting
	_, err = s.Subscribe(ctx, "team", "Rev", "Security Reviewer", "claude-Rev-2", nil, "all")
	require.NoError(t, err)
	assert.True(t, s.IsReviewsOnly(ctx, "team", "Rev"), "kept across a re-subscribe")

	no := false
	none := []string{}
	_, err = s.SetReviewSettings(ctx, "team", "Rev", &no, &none)
	require.NoError(t, err)
	assert.False(t, s.IsReviewsOnly(ctx, "team", "Rev"))
	sub, _ = s.GetProjectSubscription(ctx, "team", "Rev")
	assert.Empty(t, sub.ReviewAreas.Slice(), "an empty list is every area again")
}

func TestSetReviewSettingsRefusesWhatIsNotMemberOrNotAnArea(t *testing.T) {
	s, ctx := reviewPoolStore(t)
	yes := true
	_, err := s.SetReviewSettings(ctx, "team", "Nobody", &yes, nil)
	require.ErrorIs(t, err, ErrNotOnBoard)
	_, err = s.SetReviewSettings(ctx, "other-team", "Rev", &yes, nil)
	require.ErrorIs(t, err, ErrNotOnBoard, "another board's member")
	bad := []string{"ui", "not an area"}
	_, err = s.SetReviewSettings(ctx, "team", "Rev", &yes, &bad)
	require.ErrorIs(t, err, ErrReviewArea)
	assert.False(t, s.IsReviewsOnly(ctx, "team", "Rev"), "a refused change changes nothing, the switch included")
}
