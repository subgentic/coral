package routes

import (
	"net/http"

	"github.com/subgentic/coral/internal/auth"
	"github.com/subgentic/coral/internal/cliauth"
	"github.com/subgentic/coral/internal/peercred"
)

// peerAnswer is whose a loopback request to the cloud routes is (#409): the connection's own attribution (auth.PeerVerdict, with #385's
// retry), so the cloud gate and the identity observer read one cached verdict per connection.
type peerAnswer int

const (
	peerUnsupported peerAnswer = iota // the system can't tell users apart, or the request is not a loopback one: the caller's own rules
	peerSame                          // Coral's own OS user
	peerOther                         // definitely another OS user's, or WSL's localhost relay (#396)
	peerUndecided                     // could not be told yet (the socket table can lag a connection): "try again", never "another user"
)

// connPeerAnswer is the default peer check: the connection's cached verdict, or, on a server that attributes no connections (no
// auth.ConnContext: tests and embedders), the direct check, where any failure is "another user" (fail closed) as before.
func connPeerAnswer(r *http.Request) peerAnswer {
	v, ok := auth.PeerVerdict(r)
	if !ok {
		return answerOf(peercred.SameUser(r))
	}
	switch v {
	case peercred.Self:
		return peerSame
	case peercred.OtherUser, peercred.Relay:
		return peerOther
	case peercred.Unattributed:
		return peerUndecided
	}
	return peerUnsupported
}

// answerOf is a (same, supported) check as a peerAnswer: it can't say "undecided", so a supported "not the same" is another user.
func answerOf(same, supported bool) peerAnswer {
	switch {
	case !supported:
		return peerUnsupported
	case same:
		return peerSame
	}
	return peerOther
}

// refusePeer refuses a loopback request that is not Coral's own user's: 403 other_user (msg) for a definite other user, and 503
// cliauth.PeerUndecidedCode, "try again", when whose it is could not be told yet. That answer closes the connection, so the command line's
// retry comes on a new one, which the server attributes afresh. It reports whether it answered.
func (h *CloudHandler) refusePeer(w http.ResponseWriter, r *http.Request, msg string) bool {
	switch h.peer(r) {
	case peerOther:
		writeError(w, http.StatusForbidden, "other_user", msg)
		return true
	case peerUndecided:
		w.Header().Set("Retry-After", "1")
		w.Header().Set("Connection", "close")
		writeError(w, http.StatusServiceUnavailable, cliauth.PeerUndecidedCode, "Coral could not tell yet which user this request comes from; try again in a moment")
		return true
	}
	return false
}
