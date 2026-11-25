package routes

import (
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/subgentic/coral/pkg/hubowner"
)

// A private read with the Hub's API key and no owner stamp (#21285, the survey #21252): the saved messages and the skills are the owner's own text and what they decide on, so a later release refuses
// the key alone, as #15749 did for the questions list. This release still serves it, and says so: a header the Hub turns into its own warning (hubproxy), and one log line a day per kind here.
var keyReadLogged = struct {
	sync.Mutex
	at map[string]time.Time
}{at: map[string]time.Time{}}

// noteKeyOnlyRead sets the notice when the caller is the server's API key with no stamp (not a person, not an owner-stamped Hub, not Coral Hub's tunnel). kind is one of hubowner.KeyReadKinds.
func noteKeyOnlyRead(w http.ResponseWriter, r *http.Request, kind string) {
	if humanInputCaller(r) || !operatorOrKeyCaller(r) {
		return
	}
	w.Header().Set(hubowner.KeyReadNoticeHeader, kind)
	keyReadLogged.Lock()
	due := time.Since(keyReadLogged.at[kind]) > 24*time.Hour
	if due {
		keyReadLogged.at[kind] = time.Now()
	}
	keyReadLogged.Unlock()
	if due {
		slog.Warn("a Hub read private data with its API key and no owner stamp: a later release refuses it; set up Approve through the hub for this computer", "read", kind)
	}
}
