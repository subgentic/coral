package tunnel

import (
	"net/http"
	"testing"
)

// #13517: a goal's driver and its move to another team are the owner's own changes, made at the Hub: the Interact tier, owner-only (the computer refuses an unstamped call), no query, POST only.
func TestGoalDriverAndMoveAreOwnerOnlyInteractRoutes(t *testing.T) {
	for _, p := range []string{"/api/board/team/goals/7/driver", "/api/board/team/goals/7/move"} {
		if got := Classify(http.MethodPost, p, ""); got != TierInteract {
			t.Errorf("POST %s is %v, want the Interact tier", p, got)
		}
		if _, mode := OwnerRoute(http.MethodPost, p); mode != OwnerRefuse {
			t.Errorf("POST %s owner mode is %v, want OwnerRefuse", p, mode)
		}
		if got := Classify(http.MethodPost, p, "x=1"); got != TierNever {
			t.Errorf("POST %s with a query is %v: no query is listed", p, got)
		}
		for _, m := range []string{http.MethodGet, http.MethodPut, http.MethodPatch, http.MethodDelete} {
			if got := Classify(m, p, ""); got != TierNever {
				t.Errorf("%s %s is %v: only the POST is listed", m, p, got)
			}
		}
	}
	for _, p := range []string{"/api/board/team/goals/7/driver/extra", "/api/board/team/goals//move", "/api/board/team/goals/7/drive"} {
		if got := Classify(http.MethodPost, p, ""); got != TierNever {
			t.Errorf("POST %s is %v, want refused", p, got)
		}
	}
}
