package board

import (
	"context"
	"encoding/json"

	"github.com/subgentic/coral/internal/reviewsize"
)

// settingReviewSize holds a team's review size guard (#21022) as one JSON value in board_settings. A team that never saved it has the guard off.
const settingReviewSize = "review_size_guard"

// GetReviewSizeSetting reads the team's guard. A value that is not valid JSON or that no longer validates is an error, never "off": a guard that cannot be read must say so, not stop warning quietly.
func (s *Store) GetReviewSizeSetting(ctx context.Context, project string) (reviewsize.Setting, error) {
	raw, err := s.boardSettingValue(ctx, project, settingReviewSize)
	if err != nil || raw == "" {
		return reviewsize.Setting{}, err
	}
	var set reviewsize.Setting
	if err := json.Unmarshal([]byte(raw), &set); err != nil {
		return reviewsize.Setting{}, err
	}
	return set.Validate()
}

// SetReviewSizeSetting validates and saves the team's guard, and returns what was saved.
func (s *Store) SetReviewSizeSetting(ctx context.Context, project string, set reviewsize.Setting) (reviewsize.Setting, error) {
	set, err := set.Validate()
	if err != nil {
		return set, err
	}
	b, err := json.Marshal(set)
	if err != nil {
		return set, err
	}
	return set, s.SetBoardSetting(ctx, project, settingReviewSize, string(b))
}
