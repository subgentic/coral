package dataowner

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The warning a copy leaves for the dashboard (#12591): set at startup, adopted by the person's press, answered once.
func TestAdoptPendingAnswersTheWarningOnceAndKeepsItWhenTheAdoptFails(t *testing.T) {
	t.Cleanup(ResetCopyWarningForTest)
	ResetCopyWarningForTest()
	calls := 0
	ok, err := AdoptPending(context.Background())
	require.NoError(t, err)
	assert.False(t, ok, "no warning: nothing to answer")

	SetCopyWarning(Notice, func(context.Context) error { calls++; return errors.New("disk full") })
	assert.Equal(t, Notice, CopyWarning())
	ok, err = AdoptPending(context.Background())
	assert.True(t, ok)
	assert.Error(t, err)
	assert.Equal(t, Notice, CopyWarning(), "a failed adopt leaves the warning, so the person can press again")

	SetCopyWarning(Notice, func(context.Context) error { calls++; return nil })
	ok, err = AdoptPending(context.Background())
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Empty(t, CopyWarning())
	ok, _ = AdoptPending(context.Background())
	assert.False(t, ok, "answered once")
	assert.Equal(t, 2, calls)
}

// The notice names what Coral does (nothing is withheld) and the one answer; it is a fixed string.
func TestTheNoticeSaysCoralRunsAsUsualAndNamesTheButton(t *testing.T) {
	assert.Contains(t, Notice, "running as usual")
	assert.Contains(t, Notice, "This is my data folder")
	assert.Contains(t, LogLine(Verdict{Foreign: true, Reason: ReasonCopy}), "WARNING")
}
