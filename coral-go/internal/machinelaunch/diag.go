package machinelaunch

import (
	"context"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/ssh"

	"github.com/subgentic/coral/internal/safego"
)

// #13876: when the machine's setup does not make the credential folder, the launcher says WHY before it cleans up, because the machine (and its log) is deleted with the launch. The launch key logs in as the unprivileged
// `coral` user and cloud-init's own log is root's, so the setup keeps its own output and exit status in /run/coral (userdata.go), and the launcher reads those over the same SSH session, with cloud-init's status.
// Nothing here is a secret by design, and the text is still cleaned before it is printed: the launch's host key (the one secret in the user-data), the credential's shape, any private-key block and any long
// base64-looking run are replaced, control characters are dropped, and the whole is cut.
const (
	whyCommand = `echo "== setup exit status: $(cat /run/coral/setup.status 2>&1)"; ` +
		`echo "== setup output (tail)"; tail -c 2500 /run/coral/setup.log 2>&1; ` +
		`echo "== cloud-init status"; cloud-init status --long 2>&1 | head -c 1200; ` +
		`echo "== cloud-init output (tail)"; tail -c 1500 /var/log/cloud-init-output.log 2>&1`
	whyReadMax   = 8 << 10 // read from the machine at most this much
	whyShown     = 3000    // bytes printed, the END of what the machine said
	whyLineShown = 240
	whyTimeout   = 20 * time.Second
)

var (
	privateKeyBlock = regexp.MustCompile(`(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(-----END [A-Z ]*PRIVATE KEY-----|$)`)
	longBase64      = regexp.MustCompile(`[A-Za-z0-9+/=_\-]{60,}`)
)

// hostKeySecrets are the pieces of the launch's host key a log could echo: the whole PEM and each of its lines.
func (k *BootKeys) hostKeySecrets() []string {
	if k == nil || k.hostPriv == nil {
		return nil
	}
	pem := string(marshalHostKey(k.hostPriv))
	out := []string{strings.TrimSpace(pem)}
	for _, l := range strings.Split(pem, "\n") {
		if l = strings.TrimSpace(l); len(l) >= 16 {
			out = append(out, l)
		}
	}
	return out
}

// cleanDiagnostic is text from the machine made safe to print. Control and bidi characters go FIRST, so one placed inside a secret (chb_AB\x00CD) cannot keep it from being found; then the secrets are replaced; then the
// text is cut, on a character boundary.
func cleanDiagnostic(text string, secrets []string) string {
	text = strings.ToValidUTF8(text, "")
	text = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) || r == 0x2028 || r == 0x2029 || (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069) || r == 0xfeff || (r >= 0x200b && r <= 0x200f) {
			return -1
		}
		return r
	}, strings.ReplaceAll(text, "\r", ""))
	for _, s := range secrets {
		if s != "" {
			text = strings.ReplaceAll(text, s, "[host key]")
		}
	}
	text = privateKeyBlock.ReplaceAllString(text, "[private key]")
	text = credentialLike.ReplaceAllString(text, "[credential]")
	text = longBase64.ReplaceAllString(text, "[redacted]")
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		l = strings.TrimRight(l, " \t")
		if len(l) > whyLineShown {
			l = cutRunes(l, whyLineShown) + "…"
		}
		lines[i] = l
	}
	text = strings.TrimSpace(strings.Join(lines, "\n"))
	if len(text) > whyShown {
		text = "…" + tailRunes(text, whyShown)
	}
	return text
}

// cutRunes is the first n bytes of s or fewer, never ending inside a character.
func cutRunes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// tailRunes is the last n bytes of s or fewer, never starting inside a character.
func tailRunes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	i := len(s) - n
	for i < len(s) && !utf8.RuneStart(s[i]) {
		i++
	}
	return s[i:]
}

// whyNotReady asks the machine over the open session why its setup has not finished, and returns the cleaned answer ("" when it said nothing or the session is gone). It never fails the launch further: it runs once, on
// its own short deadline, before the machine is cleaned up.
func whyNotReady(ctx context.Context, client *ssh.Client, keys *BootKeys) string {
	ctx, cancel := context.WithTimeout(ctx, whyTimeout)
	defer cancel()
	out := &capBuffer{max: whyReadMax}
	done := make(chan struct{})
	go func() {
		defer safego.Recover("machinelaunch-why")
		defer close(done)
		_ = run(client, whyCommand, nil, out)
	}()
	select {
	case <-done:
	case <-ctx.Done():
		client.Close() // the session is not answering: let the command go
		<-done
	}
	return cleanDiagnostic(out.String(), keys.hostKeySecrets())
}
