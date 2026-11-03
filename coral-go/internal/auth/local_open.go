package auth

import (
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

// LocalOpenPath is the sign-in page's "Open Coral on this computer" button: a browser on the computer that runs Coral, signed in to Coral's own
// account, opens Coral without a password or a link from a terminal.
const LocalOpenPath = "/auth/local"

// LocalOpen mints a single-use sign-in link and sends the browser through it, for a request from this computer only.
// POST /auth/local
//
// "From this computer" is fromThisComputer, the same test that lets the sign-in page create the first password without a setup code: a loopback
// peer with no proxy header and no Coral Hub stamp, require_auth_on_loopback off, a localhost Host, the peer-user check positively saying the
// connection is Coral's own account, and the check not lost. Anything else (another computer, a proxy, another account, a system that can't tell)
// is refused, and the link the request would have had is never made. The program of the same account already gets such a link from coral open,
// so this gives no account anything it does not have.
//
// The request must come from Coral's own page: Sec-Fetch-Site same-origin and an Origin naming this server (a page on another site, or another
// port of localhost, cannot press the button for the person), and it is not an agent's (an agent's tool never signs a browser in).
func (ar *Routes) LocalOpen(w http.ResponseWriter, r *http.Request) {
	if refuseAgent(w, r) {
		return
	}
	if r.Header.Get("Sec-Fetch-Site") != "same-origin" || !sameOriginWrite(r, true) {
		authError(w, http.StatusForbidden, "cross_origin", "Open Coral from Coral's own sign-in page")
		return
	}
	if !ar.fromThisComputer(r) {
		authError(w, http.StatusForbidden, "not_this_computer", "This works only in a browser on the computer that runs Coral, in the same account. Sign in with the password, or run coral open there.")
		return
	}
	// Only while no password is set yet (the operator's choice, #289): a person who made a password signs in with it, or with coral open. "No password"
	// is a positive answer that the file does not exist; a file that cannot be read, or holds no valid password, is not that answer.
	if ar.ks.passwordState() != passwordAbsent {
		authError(w, http.StatusForbidden, "password_set", "Coral has a password: sign in with it, or run coral open on this computer.")
		return
	}
	token, err := ar.ks.MintLocalLoginToken()
	if err != nil {
		log.Printf("[auth] could not make a sign-in link for this computer: %v", err)
		authError(w, http.StatusInternalServerError, "internal", "Coral could not open: try again")
		return
	}
	// The link is used at once by the redirect it is in, through the same checks as any other link (handleLoginToken); it is in no log.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	http.Redirect(w, r, "/?"+LoginTokenParam+"="+token, http.StatusSeeOther)
}

// passwordState is whether a password is set, positively absent, or neither (unreadable).
type passwordState int

const (
	passwordUnreadable passwordState = iota // the file is there but cannot be read, or does not hold a valid password: never taken as "no password"
	passwordAbsent                          // the file does not exist
	passwordIsSet                           // the file holds a valid password
)

// passwordState reads the password file's state. Only a file that does not exist is absent; any other error, an empty file or one that does not
// parse is unreadable.
func (ks *KeyStore) passwordState() passwordState {
	if ks == nil || ks.keyPath == "" {
		return passwordUnreadable
	}
	dir := ks.dataDir()
	if _, err := os.Lstat(filepath.Join(dir, PasswordFile)); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return passwordAbsent
		}
		return passwordUnreadable
	}
	if phc, err := ReadPasswordHash(dir); err == nil && phc != "" {
		return passwordIsSet
	}
	return passwordUnreadable
}

// LocalOpenOffered is whether the sign-in page offers "Open Coral on this computer" to r: this computer in Coral's account (fromThisComputer),
// and no password set yet, by a positive answer. LocalOpen checks the same itself.
func (ar *Routes) LocalOpenOffered(r *http.Request) bool {
	return ar.fromThisComputer(r) && ar.ks.passwordState() == passwordAbsent
}
