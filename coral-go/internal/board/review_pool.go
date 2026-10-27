package board

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// The review pool (#8957, Goal #80): reviews wait on the board, not with the orchestrator, and agents that only review take the oldest one that matches the areas they cover. This file holds the
// vocabulary (areas) and the agent's own setting; the pool's rules are in review_pool_claim.go.

const (
	// MaxReviewAreas bounds the areas of one review and of one agent.
	MaxReviewAreas = 8
	// MaxReviewersWanted: a review can ask for two reviewers; one is the default.
	MaxReviewersWanted = 2
)

// reviewAreaPattern is an area word: a lowercase slug (ui, go, security, docs, release...).
var reviewAreaPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,23}$`)

// ErrReviewArea is an area word or a set of them that is refused.
var ErrReviewArea = fmt.Errorf("invalid review area")

// NormalizeReviewAreas lowercases, trims and de-duplicates areas, in the order given. A word that is not an area, or more than MaxReviewAreas, is an error naming it.
func NormalizeReviewAreas(in []string) ([]string, error) {
	out := []string{}
	seen := map[string]bool{}
	for _, raw := range in {
		a := strings.ToLower(strings.TrimSpace(raw))
		if a == "" {
			continue
		}
		if !reviewAreaPattern.MatchString(a) {
			return nil, fmt.Errorf("%w: %q (a lowercase word of 1 to 24 letters, digits or hyphens)", ErrReviewArea, raw)
		}
		if !seen[a] {
			seen[a] = true
			out = append(out, a)
		}
	}
	if len(out) > MaxReviewAreas {
		return nil, fmt.Errorf("%w: at most %d areas", ErrReviewArea, MaxReviewAreas)
	}
	return out, nil
}

// AreaList is a set of areas as the board_subscribers column keeps it (comma separated) and as the API shows it (a JSON array, never null).
type AreaList string

// Slice is the areas, empty for none.
func (a AreaList) Slice() []string {
	if a == "" {
		return []string{}
	}
	return strings.Split(string(a), ",")
}

// MarshalJSON shows the areas as an array.
func (a AreaList) MarshalJSON() ([]byte, error) { return json.Marshal(a.Slice()) }

// AreasMatch reports whether a reviewer who takes reviewerAreas (empty: every area) may take a review tagged reviewAreas (empty: any reviewer): the two overlap, or one of them is empty.
func AreasMatch(reviewerAreas, reviewAreas []string) bool {
	if len(reviewerAreas) == 0 || len(reviewAreas) == 0 {
		return true
	}
	for _, r := range reviewerAreas {
		for _, a := range reviewAreas {
			if r == a {
				return true
			}
		}
	}
	return false
}

// ReviewSettings is an agent's review setting after a change.
type ReviewSettings struct {
	SubscriberID string   `json:"subscriber_id"`
	ReviewsOnly  bool     `json:"reviews_only"`
	ReviewAreas  []string `json:"review_areas"`
}

// ErrNotOnBoard: the named member is not an active subscriber of the board.
var ErrNotOnBoard = fmt.Errorf("that agent is not on this board")

// SetReviewSettings changes an agent's "Reviews only" switch and its areas; a nil argument leaves that part as it is. The areas are normalised; the agent must be an active member.
func (s *Store) SetReviewSettings(ctx context.Context, project, subscriberID string, reviewsOnly *bool, areas *[]string) (*ReviewSettings, error) {
	sub, err := s.GetProjectSubscription(ctx, project, subscriberID)
	if err != nil {
		return nil, err
	}
	if sub == nil {
		return nil, ErrNotOnBoard
	}
	only, list := sub.ReviewsOnly, sub.ReviewAreas.Slice()
	if reviewsOnly != nil {
		only = *reviewsOnly
	}
	if areas != nil {
		if list, err = NormalizeReviewAreas(*areas); err != nil {
			return nil, err
		}
	}
	flag := 0
	if only {
		flag = 1
	}
	res, err := s.db.ExecContext(ctx, `UPDATE board_subscribers SET reviews_only = ?, review_areas = ? WHERE project = ? AND subscriber_id = ? AND is_active = 1`,
		flag, strings.Join(list, ","), project, sub.SubscriberID)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, sql.ErrNoRows
	}
	s.subscribersChanged()
	return &ReviewSettings{SubscriberID: sub.SubscriberID, ReviewsOnly: only, ReviewAreas: list}, nil
}

// IsReviewsOnly reports whether the agent is an active member set to take reviews only.
func (s *Store) IsReviewsOnly(ctx context.Context, project, subscriberID string) bool {
	sub, err := s.GetProjectSubscription(ctx, project, subscriberID)
	return err == nil && sub != nil && sub.ReviewsOnly
}
