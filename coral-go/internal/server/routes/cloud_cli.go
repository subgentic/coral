package routes

import (
	"bytes"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/subgentic/coral/internal/auth"
	"github.com/subgentic/coral/internal/cliauth"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/httputil"
)

// RotateCLIToken writes a new command-line token and makes the server use it, after
// `coral reset-password` (#4041): whatever read the old one (an agent, a copy) can no longer
// sign as the Operator. Pending hellos are dropped; each command line reads the new token on
// its next request.
func (h *CloudHandler) RotateCLIToken() {
	tok, err := cloud.WriteCLIToken(h.dataDir)
	if err != nil {
		// Fail closed: an old token that may be known must not keep signing.
		slog.Warn("cloud: could not write a new command-line token after a password reset; the command line is off until Coral restarts", "error", err)
		tok = ""
	}
	h.cliAuth.Rotate(tok)
	h.mu.Lock()
	h.cliToken = tok
	h.mu.Unlock()
	slog.Info("cloud: the command-line token was replaced after a password reset")
}

// CLIHello: POST /api/cloud/cli-hello {"nonce": c}, step 1 of the command
// line's handshake (cloud.CLIAuth): the server proves it knows the token. Only a
// loopback command-line request as Coral's user, never through the tunnel.
func (h *CloudHandler) CLIHello(w http.ResponseWriter, r *http.Request) {
	if cloud.Tunneled(r) {
		errForbidden(w, "Cloud connector settings are only available on this computer")
		return
	}
	if h.refusePeer(w, r, "Cloud connector settings are only available to the user Coral runs as") {
		return // another user's: 403; not told yet: 503 "try again", which cliauth retries on a new connection (#409)
	}
	if !localCLI(r) {
		errForbidden(w, "Only `coral cloud connect`, run on this computer, can do this")
		return
	}
	if !requireJSON(w, r) {
		return
	}
	var body struct {
		Nonce string `json:"nonce"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "nonce is required")
		return
	}
	// Only a direct local peer gets here (localCLI), so every hello is one caller: a program
	// can't get a bucket per loopback address and fill the pending table (#4041).
	sn, proof, err := h.cliAuth.HelloFrom("local", body.Nonce)
	if errors.Is(err, cliauth.ErrHelloLimit) {
		httputil.WriteActionLimit(w, 1, "cli_hello_limit", err.Error())
		return
	}
	if err != nil {
		errBadRequest(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"nonce": sn, "proof": proof})
}

// VerifyCLI checks a command-line signature for strict local auth (#3418): a loopback
// request without browser headers, from Coral's own user, signed with the command-line
// token. It uses up the nonce and returns the request marked cliauth.Verified, with its
// body restored, so the cloud routes accept it without checking again.
func (h *CloudHandler) VerifyCLI(r *http.Request) (*http.Request, bool) {
	if r.Header.Get(cloud.CLIAuthHeader) == "" || !localCLI(r) {
		return r, false
	}
	if a := h.peer(r); a == peerOther || a == peerUndecided {
		return r, false // only Coral's own user's signature is checked; one whose user isn't told yet is not
	}
	var body []byte
	if r.Body != nil && r.Body != http.NoBody {
		b, err := io.ReadAll(io.LimitReader(r.Body, cliSignedBodyMax+1))
		r.Body.Close()
		if err != nil || len(b) > cliSignedBodyMax {
			return r, false
		}
		body = b
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	if !h.cliAuth.Verify(r, body) {
		return r, false
	}
	return cliauth.WithVerified(r), true
}

// SameUser is the peer-user check (#3949): whether a loopback request comes from Coral's own OS
// user, and whether the system can tell at all.
// A connection whose user isn't told yet is "not the same user" here (fail closed).
func (h *CloudHandler) SameUser(r *http.Request) (same, supported bool) {
	a := h.peer(r)
	return a == peerSame, a != peerUnsupported
}

// OtherUser reports whether a loopback request comes from another OS user, positively (#409): such a caller is refused with code
// other_user. One whose user isn't told yet is not "another user" (it is asked again, or needs a credential like any unattributed one).
func (h *CloudHandler) OtherUser(r *http.Request) bool { return h.peer(r) == peerOther }

// cliSignedBodyMax matches the command-line transport's limit (an artifact upload).
const cliSignedBodyMax = 32 << 20

// localCLI admits only a command-line client on this computer: a loopback peer
// with a localhost Host, no tunnel stamp (any value), and nothing a browser
// sends (Origin, Referer, fetch metadata), so neither the Cloud Hub, another
// machine nor a web page can reach it.
func localCLI(r *http.Request) bool {
	if viaTunnel(r) || r.Header.Get("Origin") != "" || r.Header.Get("Referer") != "" || r.Header.Get("Sec-Fetch-Site") != "" {
		return false
	}
	// A direct local peer only (#3585): a request a local proxy forwarded is not the command line
	// on this computer. The require_auth_on_loopback clause is intentionally NOT applied here --
	// the signed handshakes signature is the credential, so the setting is already satisfied and
	// must not block `coral cloud connect`.
	if !auth.IsDirectLocalPeer(r) {
		return false
	}
	return localHostOK(r.Host)
}
