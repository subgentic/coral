package tunnel

import (
	"net/http"
	"strings"
	"testing"
)

// #19627 (the Skills page through the Hub, coral-hub's Operator yes): the two reads of the page are View and the computer owner's alone; the writes stay never; the id of a skill is exactly 32
// lowercase hex digits, a {hex32} segment, and no other length or character is a skill.
func TestSkillsPageReadsAreViewAndOwnerOnlyAndTheWritesStayNever(t *testing.T) {
	id := strings.Repeat("ab12", 8)
	for _, path := range []string{"/api/skills", "/api/skills/" + id} {
		if got := Classify(http.MethodGet, path, ""); got != TierView {
			t.Errorf("GET %s = %v, want view", path, got)
		}
		if _, mode := OwnerRoute(http.MethodGet, path); mode != OwnerRefuse {
			t.Errorf("GET %s owner mode = %v, want OwnerRefuse (the owner's alone)", path, mode)
		}
	}
	never := []struct{ method, path string }{
		{http.MethodPost, "/api/skills"},
		{http.MethodPost, "/api/skills/" + id + "/approve"},
		{http.MethodPost, "/api/skills/" + id + "/reject"},
		{http.MethodDelete, "/api/skills/" + id},
		{http.MethodPut, "/api/skills/" + id},
		{http.MethodPatch, "/api/skills/" + id},
		{http.MethodGet, "/api/skills/" + id[:31]},                  // 31 digits
		{http.MethodGet, "/api/skills/" + id + "0"},                 // 33 digits
		{http.MethodGet, "/api/skills/" + strings.Repeat("ab", 32)}, // a 64-digit digest is not a skill id
		{http.MethodGet, "/api/skills/" + strings.ToUpper(id)},      // lowercase only
		{http.MethodGet, "/api/skills/" + id[:31] + "g"},            // not hex
		{http.MethodGet, "/api/skills/" + id + "/files"},            // no sibling read
		{http.MethodGet, "/api/agent/skills"},                       // the agent's own routes stay out
		{http.MethodGet, "/api/agent/skills/" + id},
	}
	for _, c := range never {
		if got := Classify(c.method, c.path, ""); got != TierNever {
			t.Errorf("%s %s = %v, want never", c.method, c.path, got)
		}
	}
	// the menu's search is still its own literal route, not a skill id
	if got := Classify(http.MethodGet, "/api/skills/search", ""); got != TierView {
		t.Errorf("GET /api/skills/search = %v, want view", got)
	}
}

// The query of the list is the one status word and nothing else; the shape a generated table holds for a {hex32} route is allowed.
func TestSkillsListQueryAndShape(t *testing.T) {
	if got := Classify(http.MethodGet, "/api/skills", "status=pending"); got != TierView {
		t.Errorf("GET /api/skills?status=pending = %v, want view", got)
	}
	if got := Classify(http.MethodGet, "/api/skills", "status=pending&q=x"); got != TierNever {
		t.Errorf("an unlisted query parameter must refuse, got %v", got)
	}
	if !ShapeAllowed(http.MethodGet, "/api/skills/{}") {
		t.Error("ShapeAllowed must accept the {hex32} shape of GET /api/skills/{id}")
	}
}
