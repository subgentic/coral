package store

import (
	"errors"
	"fmt"
	"github.com/stretchr/testify/require"
	"testing"
)

type chiefDBError struct {
	code int
	text string
}

func (e chiefDBError) Error() string { return e.text }
func (e chiefDBError) Code() int     { return e.code }

func TestChiefTriggerConflictClassificationIsNarrow(t *testing.T) {
	const duplicate = "constraint failed: UNIQUE constraint failed: chief_triggers.check_id (2067)"
	for _, tc := range []struct {
		name     string
		err      error
		conflict bool
	}{
		{"actual unique check", chiefDBError{2067, duplicate}, true},
		{"wrapped unique check", fmt.Errorf("update: %w", chiefDBError{2067, duplicate}), true},
		{"busy with misleading text", chiefDBError{5, duplicate}, false},
		{"aborted update", chiefDBError{1811, duplicate}, false},
		{"another unique index", chiefDBError{2067, "UNIQUE constraint failed: some_other_table.id"}, false},
		{"untyped storage failure", errors.New(duplicate), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := chiefTriggerStateError(tc.err)
			require.Equal(t, tc.conflict, errors.Is(got, ErrChiefTriggerConflict))
			require.ErrorIs(t, got, tc.err, "original storage cause stays available internally")
		})
	}
}
