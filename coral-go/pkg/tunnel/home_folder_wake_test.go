package tunnel

import "testing"

// #13425 (Security's SHOULD 3): the dashboard's wake says home_folder_ask and confirm_home_folder in its POST body, as a launch does. The tunnel lists no query for the wake (a query it does not list is refused: the
// route is then TierNever), so a query form would have refused every wake through the Coral Hub. The route stays at the Launch tier with no query, and the query form is the one that is refused.
func TestWakeThroughTheHubCarriesTheHomeFolderQuestionInItsBody(t *testing.T) {
	const path = "/api/sessions/live/agent-1/wake"
	if got := Classify("POST", path, ""); got != TierLaunch {
		t.Fatalf("a wake with no query is %v, want the Launch tier (its body carries home_folder_ask and confirm_home_folder)", got)
	}
	for _, q := range []string{"home_folder_ask=1", "confirm_home_folder=1", "home_folder_ask=1&confirm_home_folder=1"} {
		if got := Classify("POST", path, q); got != TierNever {
			t.Errorf("a wake with the query %q is %v: it must stay refused, so the question travels in the body", q, got)
		}
	}
}
