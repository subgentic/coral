package tunnel

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #14440: the two thread reads are the owner's alone through Coral Hub, at View tier, and take only the keys the note lists; any other key is never.
func TestTheThreadReadsAreOwnerOnlyViewRoutesWithTheirOwnKeys(t *testing.T) {
	for path, ok := range map[string]string{
		"/api/thread":  "team=alpha&task=3&order=asc&limit=10&after=x",
		"/api/threads": "team=alpha&goal=2&state=waiting&limit=10&after=x",
	} {
		assert.Equal(t, TierView, Classify(http.MethodGet, path, ok), path)
		pattern, mode := OwnerRoute(http.MethodGet, path)
		assert.Equal(t, path, pattern)
		assert.Equal(t, OwnerRefuse, mode, path+": the owner's alone, refused for anyone else by the machine")
		assert.Equal(t, TierNever, Classify(http.MethodGet, path, ok+"&surprise=1"), path+": an unknown key")
		for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
			assert.Equal(t, TierNever, Classify(m, path, ""), path+": only GET "+m)
		}
	}
	// the keys of one read are not the other's
	assert.Equal(t, TierNever, Classify(http.MethodGet, "/api/thread", "team=alpha&task=3&state=waiting"))
	assert.Equal(t, TierNever, Classify(http.MethodGet, "/api/threads", "team=alpha&task=3"))
}

// #14472 (QA review of #14440): the keys are EXACTLY the note's. A key the read does not take, however plausible, is never; a mutant that adds one to the list passed the test above, which only tried "surprise".
func TestTheThreadReadsTakeExactlyTheKeysOfTheNoteAndNoOther(t *testing.T) {
	for path, keys := range map[string][]string{
		"/api/thread":  {"after", "goal", "limit", "order", "task", "team"},
		"/api/threads": {"after", "goal", "limit", "state", "team"},
	} {
		for _, k := range keys {
			assert.Equal(t, TierView, Classify(http.MethodGet, path, k+"=1"), path+": the key "+k+" is taken")
		}
		for _, k := range []string{"debug", "raw", "redact", "fields", "include", "as", "actor", "token", "session_id", "hub_user", "operator", "text", "q", "sort", "since", "before", "before_at", "full", "verbose", "format"} {
			ok := false
			for _, own := range keys {
				ok = ok || own == k
			}
			if !ok {
				assert.Equal(t, TierNever, Classify(http.MethodGet, path, "team=alpha&"+k+"=1"), path+": the key "+k+" is not taken")
			}
		}
	}
}
