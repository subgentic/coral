// gdoc-login signs a throwaway Google account in for the Google Doc live checks (#19953).
// It asks for the OAuth client (desktop app) id and secret, opens Google's own sign-in in the browser (the person types their password there, never here),
// receives the code on a loopback port, and stores the client and the refresh token in the macOS keychain. It prints nothing secret.
//
//	gdoc-login                # drive.file only          (keychain account "file", the default)
//	gdoc-login -scopes full   # drive.file + documents   (keychain account "full")
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"flag"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"

	coralauth "github.com/subgentic/coral/internal/auth"
	"github.com/subgentic/coral/internal/gdocsync"
)

func rnd() string {
	b := make([]byte, 32)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func main() {
	scopes := flag.String("scopes", "file", "file (drive.file only, the default) or full (drive.file + documents)")
	browser := flag.String("browser", "", "open the sign-in in this app, e.g. \"Google Chrome\" (default: copy the address to the clipboard)")
	flag.Parse()
	scope := "https://www.googleapis.com/auth/drive.file"
	if *scopes == "full" {
		scope += " https://www.googleapis.com/auth/documents"
	} else if *scopes != "file" {
		fmt.Fprintln(os.Stderr, "-scopes is full or file")
		os.Exit(2)
	}
	in := bufio.NewReader(os.Stdin)
	fmt.Print("OAuth client id: ")
	id, _ := in.ReadString('\n')
	fmt.Print("OAuth client secret (typing is hidden): ")
	exec.Command("stty", "-echo").Run() // best effort; restored below
	sec, _ := in.ReadString('\n')
	exec.Command("stty", "echo").Run()
	fmt.Println()
	id, sec = strings.TrimSpace(id), strings.TrimSpace(sec)
	if id == "" || sec == "" {
		fmt.Fprintln(os.Stderr, "both are needed")
		os.Exit(1)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintln(os.Stderr, "no loopback port:", err)
		os.Exit(1)
	}
	redirect := fmt.Sprintf("http://127.0.0.1:%d/", ln.Addr().(*net.TCPAddr).Port)
	verifier, state := rnd(), rnd()
	sum := sha256.Sum256([]byte(verifier))
	auth := "https://accounts.google.com/o/oauth2/v2/auth?" + url.Values{
		"client_id": {id}, "redirect_uri": {redirect}, "response_type": {"code"}, "scope": {scope},
		"access_type": {"offline"}, "prompt": {"consent"}, "state": {state},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"},
	}.Encode()
	code := make(chan string, 1)
	go (&http.Server{ReadHeaderTimeout: 10 * time.Second, ConnContext: coralauth.ConnContext, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("state") != state || q.Get("code") == "" {
			http.Error(w, "not the sign-in this tool started", 400)
			return
		}
		fmt.Fprintln(w, "Signed in. You can close this tab and go back to the terminal.")
		select {
		case code <- q.Get("code"):
		default:
		}
	})}).Serve(ln)
	// not opened for the person: the default browser is often not the one the throwaway account lives in. The address (no secret in it) is copied to the clipboard and printed.
	cp := exec.Command("pbcopy")
	cp.Stdin = strings.NewReader(auth)
	copied := cp.Run() == nil
	if *browser != "" {
		exec.Command("open", "-a", *browser, auth).Run()
		fmt.Printf("Opened Google's sign-in in %s.\n", *browser)
	} else if copied {
		fmt.Println("Google's sign-in address is on your clipboard (or run again with -browser \"Google Chrome\").")
	}
	if *browser == "" {
		fmt.Println("Paste this into the browser where the spare account is signed in:\n" + auth)
	}
	var c string
	select {
	case c = <-code:
	case <-time.After(5 * time.Minute):
		fmt.Fprintln(os.Stderr, "timed out waiting for the sign-in")
		os.Exit(1)
	}
	t, err := gdocsync.Exchange(context.Background(), url.Values{"grant_type": {"authorization_code"}, "code": {c}, "client_id": {id}, "client_secret": {sec}, "redirect_uri": {redirect}, "code_verifier": {verifier}})
	if err != nil || t.Refresh == "" {
		fmt.Fprintln(os.Stderr, "sign-in failed:", err)
		os.Exit(1)
	}
	if err := gdocsync.StoreCreds(*scopes, gdocsync.Creds{ClientID: id, ClientSecret: sec, RefreshToken: t.Refresh}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("Stored in the keychain as %q (granted: %s). Nothing was printed or written to a file.\n", *scopes, t.Scope)
}
