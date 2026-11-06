package machinelaunch

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13876: a setup that does not finish says why, from what the machine keeps, before it is deleted; and what it says is cleaned, because the user-data holds the launch's host key and a log can echo anything.

func TestAMachineThatNeverMakesTheFolderSaysWhyAndNothingSecretPrints(t *testing.T) {
	m := &slowMachine{after: 1 << 30}
	p, h := &stubProvider{}, &stubHub{}
	o, d, _, srv := setupWith(t, p, h)
	var asked int
	srv.handle = func(cmd, stdin string) (string, string, uint32) {
		if cmd == whyCommand {
			asked++
			return "== setup exit status: 2\n== setup output (tail)\ntar: coral: Not found in archive\ntar: Exiting with failure status due to previous errors\n" +
				"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----\n" +
				"token chb_SECRETSECRETSECRET1234 and a blob " + strings.Repeat("QUJD", 30) + "\x1b[31m red \x07 \u202e reversed\n", "", 0
		}
		return m.handle(cmd, stdin)
	}
	d.Bootstrap.(*SSHBootstrap).ReadyWait = 150 * time.Millisecond
	_, err := Launch(context.Background(), o, d)
	require.Error(t, err)
	require.True(t, errors.Is(err, ErrMachineNotReady))
	msg := err.Error()
	assert.Equal(t, 1, asked, "asked once, before the machine is cleaned up")
	assert.Contains(t, msg, "tar: coral: Not found in archive", "the reason is printed")
	assert.Contains(t, msg, "setup exit status: 2")
	assert.Contains(t, msg, credentialDir)
	for _, secret := range []string{"chb_SECRETSECRET", "b3BlbnNzaC1rZXkt", "BEGIN OPENSSH PRIVATE KEY", strings.Repeat("QUJD", 30), "\x1b", "\x07", "\u202e"} {
		assert.NotContains(t, msg, secret)
	}
	assert.Less(t, len(msg), 3600, "capped")
	assert.Equal(t, 0, len(m.delivered), "nothing was sent")
}

func TestTheHostKeyIsReplacedWhereverALogEchoesIt(t *testing.T) {
	keys, err := NewBootKeys()
	require.NoError(t, err)
	pem := string(marshalHostKey(keys.hostPriv))
	body := strings.Split(strings.TrimSpace(pem), "\n")
	require.Greater(t, len(body), 2)
	line := body[1]
	out := cleanDiagnostic("user-data says:\n"+pem+"\nand one line alone: "+line+"\n", keys.hostKeySecrets())
	assert.NotContains(t, out, line)
	assert.NotContains(t, out, "PRIVATE KEY")
	assert.Contains(t, out, "user-data says:")
}

func TestADiagnosticIsCutToItsTailAndItsLongLines(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 400; i++ {
		b.WriteString("line of a log number words words words\n")
	}
	b.WriteString("THE LAST LINE: exit 7\n")
	out := cleanDiagnostic(b.String(), nil)
	assert.LessOrEqual(t, len(out), whyShown+8)
	assert.Contains(t, out, "THE LAST LINE: exit 7", "it is the END of the log that says why")
	long := cleanDiagnostic("x "+strings.Repeat("ab ", 300), nil)
	assert.LessOrEqual(t, len(long), whyLineShown+8)
}

func TestAMachineThatCannotBeAskedStillFailsClearly(t *testing.T) {
	m := &slowMachine{after: 1 << 30}
	p, h := &stubProvider{}, &stubHub{}
	o, d, _, srv := setupWith(t, p, h)
	srv.handle = func(cmd, stdin string) (string, string, uint32) {
		if cmd == whyCommand {
			return "", "", 1 // says nothing
		}
		return m.handle(cmd, stdin)
	}
	d.Bootstrap.(*SSHBootstrap).ReadyWait = 150 * time.Millisecond
	_, err := Launch(context.Background(), o, d)
	require.True(t, errors.Is(err, ErrMachineNotReady))
	assert.Contains(t, err.Error(), "could not be asked why")
}

// Security's SHOULD on #13876: a control character placed inside a secret must not keep it from being found, and a cut never splits a character.
func TestAControlCharacterInsideASecretDoesNotDodgeItsRedaction(t *testing.T) {
	keys, err := NewBootKeys()
	require.NoError(t, err)
	line := strings.Split(strings.TrimSpace(string(marshalHostKey(keys.hostPriv))), "\n")[1]
	split := line[:10] + "\x00\x1b" + line[10:]
	out := cleanDiagnostic("token chb_AB\x00CD\u202eEF1234 and "+split+"\n", keys.hostKeySecrets())
	assert.NotContains(t, out, "chb_")
	assert.NotContains(t, out, "ABCDEF1234")
	assert.NotContains(t, out, line[:20])
	assert.Contains(t, out, "[credential]")
}

func TestACutNeverSplitsACharacter(t *testing.T) {
	long := cleanDiagnostic("x"+strings.Repeat("é", 400), nil) // two bytes each after one byte: the cap falls inside a character
	assert.True(t, utf8.ValidString(long))
	assert.LessOrEqual(t, len(long), whyLineShown+4)
	var b strings.Builder
	for i := 0; i < 1500; i++ {
		b.WriteString("é\n") // 3 bytes a line, the tail cut falls inside one for some lengths
	}
	for n := 0; n < 4; n++ {
		tail := cleanDiagnostic(strings.Repeat("x", n)+b.String(), nil)
		assert.True(t, utf8.ValidString(tail), n)
	}
}
