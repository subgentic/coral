package redact

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #7279 (QA's #7274 note 5): the shapes a View viewer can read in a held message or a waiting summary and that were not redacted: a password given to a command as a flag (sshpass -p, mysql's attached -p,
// the long --password forms) and the npm and Slack token prefixes. The must-redact rows say where the value was; the must-pass rows are what looks alike and is not a secret (a port, a path, a word), which
// stays as it is. Bare hex and passwords in prose are out of scope.
func TestCLIPasswordFlagsAndTokenPrefixesAreRedacted(t *testing.T) {
	// Token-shaped strings are built from pieces when the test runs, so no literal of one is in the source (a secret scanner reads this file too).
	npm := cat("npm", "_", "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789")
	slackBot := cat("xo", "xb-123456789012-1234567890123-", "AbCdEfGhIjKlMnOpQrStUvWx")
	slackUser := cat("xo", "xp-123456789012-123456789012-123456789012-", "abcdef0123456789abcdef0123456789")
	slackApp := cat("xa", "pp-1-A0123456789-1234567890123-", "abcdef0123456789abcdef0123456789abcdef")
	slackRefresh := cat("xo", "xe.xo", "xp-1-", "Mi0yLTEyMzQ1Njc4OTAxMjM0NTY3ODkw")
	hook := cat("https://hooks", ".slack.com/services/T01234567/B01234567/", "AbCdEfGhIjKlMnOpQrStUvWx")
	for _, c := range []struct{ in, want string }{
		// sshpass
		{"sshpass -p 'x' ssh host", "sshpass -p '" + sm + "' ssh host"},
		{`sshpass -p "pa ss" ssh host`, `sshpass -p "` + sm + `" ssh host`},
		{"sshpass -p hunter2 ssh host", "sshpass -p " + sm + " ssh host"},
		{"sshpass -phunter2 ssh host", "sshpass -p" + sm + " ssh host"},
		{"sshpass -f ~/pw ssh host", "sshpass -f ~/pw ssh host"}, // a file, not a password
		// mysql family: the password attached to -p
		{"mysql -u root -pSecret123 db", "mysql -u root -p" + sm + " db"},
		{"mysqldump -pPASSWORD --all-databases", "mysqldump -p" + sm + " --all-databases"},
		{"mariadb -h db -u app -p'pa ss' app", "mariadb -h db -u app -p'" + sm + "' app"},
		{"mysqladmin -u root -pxyz status", "mysqladmin -u root -p" + sm + " status"},
		{"mysql -p", "mysql -p"},                           // asks on the terminal: no value
		{"mysql -P 3306 -u root", "mysql -P 3306 -u root"}, // capital P is the port
		{"mysql -u root db < dump.sql && echo -pdone", "mysql -u root db < dump.sql && echo -pdone"}, // another command's -p
		// long password flags
		{"tool --password hunter2 --x", "tool --password " + sm + " --x"},
		{"tool --password=hunter2 --x", "tool --password=" + sm + " --x"},
		{"tool --passwd 'a b' next", "tool --passwd '" + sm + "' next"},
		{"tool --pass hunter2", "tool --pass " + sm},
		{"set the --password flag in the config", "set the --password " + sm + " in the config"}, // fails closed: a word after the flag is read as its value, prose included
		{"tool --pwd hunter2", "tool --pwd " + sm},
		{"login --token tk_12345abc", "login --token " + sm},
		{"cli --api-key k3y --verbose", "cli --api-key " + sm + " --verbose"},
		{"redis-cli -a hunter2 ping", "redis-cli -a " + sm + " ping"},
		{"curl -u admin:hunter2 https://h/x", "curl -u admin:" + sm + " https://h/x"},
		{"docker login -u me -p hunter2 reg", "docker login -u me -p " + sm + " reg"},
		{"openssl x509 -passin pass:hunter2", "openssl x509 -passin pass:" + sm},
		// tokens
		{"NPM " + npm + " done", "NPM " + sm + " done"},
		{"//registry.npmjs.org/:_authToken=" + npm, "//registry.npmjs.org/:_authToken=" + sm},
		{"slack " + slackBot + " end", "slack " + sm + " end"},
		{slackUser, sm},
		{slackApp, sm},
		{slackRefresh, sm},
		{hook, hook[:strings.LastIndex(hook, "/")+1] + sm},
	} {
		assert.Equal(t, c.want, string(Tokens([]byte(c.in))), c.in)
	}
}

// cat joins the pieces of a token-shaped test string at run time.
func cat(parts ...string) string { return strings.Join(parts, "") }

// What looks alike and is left alone.
func TestCLIFlagRulesLeaveOrdinaryCommandsAlone(t *testing.T) {
	for _, in := range []string{
		"ssh -p 22 host", "ssh -p22 host", "scp -P 2222 f host:", "docker run -p 80:80 nginx", "pg_dump -p 5432 db", "ls -p", "mkdir -p a/b", "cp -pr a b",
		"git push --password-stdin", "tool --passphrase-file ~/p", "tool --token-file t", "npm install npm_config_cache", "echo npm_ is a prefix", "xoxb is a word",
		"mysql -u root db", "the password is in the vault",
	} {
		assert.Equal(t, in, string(Tokens([]byte(in))), in)
	}
}

// The same rules on a stream: any split of the text into writes gives what the whole text gives (the Writer's contract), at every split point of every row of the tables above.
func TestCLIFlagRulesGiveTheSameOutputOnAStreamSplitAnywhere(t *testing.T) {
	for _, in := range []string{
		"sshpass -p 'x' ssh host", `sshpass -p "pa ss" ssh host`, "sshpass -phunter2 ssh host", "mysql -u root -pSecret123 db", "mariadb -h db -u app -p'pa ss' app",
		"tool --password hunter2 --x", "tool --password=hunter2 --x", "redis-cli -a hunter2 ping", "curl -u admin:hunter2 https://h/x", "docker login -u me -p hunter2 reg",
		"openssl x509 -passin pass:hunter2", cat("npm", "_", "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 x"), cat("xa", "pp-1-A0123456789-1234567890123-", "abcdef0123456789abcdef"), cat("https://hooks", ".slack.com/services/T01234567/B01234567/", "AbCdEfGhIjKlMnOpQrStUvWx"),
		"ssh -p 22 host mysql -u root db", "mysql -p", "echo mysql\nnext line",
	} {
		whole := string(Tokens([]byte(in)))
		for cut := 1; cut < len(in); cut++ {
			assert.Equal(t, whole, redactStream(in[:cut], in[cut:]), "%q split at %d", in, cut)
		}
	}
}
