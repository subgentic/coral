package redact

// Passwords given to a command as an argument (#7279): sshpass -p, mysql's attached -pPASSWORD, redis-cli -a, docker login -p, curl -u user:password, openssl -passin pass:, and the long --password,
// --token and --api-key flags with the value after a space or "=". The command's name is the rule's prefix and the glue walks its arguments (to the end of the command: a newline, ; & | or a backtick)
// to the one that carries the password, so a word that only looks alike (ssh -p 22, mkdir -p, ls -p, echo -pdone after &&) is left. Bare hex and a password in prose are not covered.

// maxCmdScan bounds how far the glue walks a command's arguments: a longer command line is not scanned past it.
const maxCmdScan = 300

func isBlank(c byte) bool { return c == ' ' || c == '\t' }

// cmdEnd: a byte that ends a shell command's arguments.
func cmdEnd(c byte) bool {
	return c == '\n' || c == '\r' || c == ';' || c == '&' || c == '|' || c == '`'
}

// wordEnd is the index just past the word starting at i: up to a blank, a command end or the buffer's end; a quoted part is walked to its closing quote. -2: the buffer ends inside a quote.
func wordEnd(b []byte, i int) int {
	for i < len(b) {
		c := b[i]
		switch {
		case isBlank(c) || cmdEnd(c):
			return i
		case c == '\'' || c == '"':
			j := i + 1
			for j < len(b) && b[j] != c && b[j] != '\n' {
				j++
			}
			if j >= len(b) {
				return -2
			}
			if b[j] == '\n' {
				return j
			}
			i = j + 1
		default:
			i++
		}
	}
	return i
}

// valueAt is where a flag's value starts at b[i]: after an opening quote, when it opens with one (the quoted value runs to its closing quote), else at i.
func valueAt(b []byte, i int) int {
	if i < len(b) && (b[i] == '\'' || b[i] == '"') {
		return i + 1
	}
	return i
}

// argPick decides, for the word at b[i], whether it carries the password: the value's start (decided), or -1 (not this word), or -2 (more bytes are needed to tell).
type argPick func(b []byte, i int) int

// nextWordValue is where the value of a flag that takes it as the NEXT word starts, the flag ending at j: after the blanks, -1 when the command ends or another flag follows, -2 at the buffer's end.
func nextWordValue(b []byte, j int) int {
	for j < len(b) && isBlank(b[j]) {
		j++
	}
	switch {
	case j >= len(b):
		return -2
	case cmdEnd(b[j]) || j == 0:
		return -1
	case b[j] == '-' && j+1 < len(b) && b[j+1] != ' ':
		return -1 // another flag, not a value (a password starting with "-" is not caught)
	}
	return valueAt(b, j)
}

// argGlue makes a glue that walks the arguments after the command name and returns where pick says the value starts.
func argGlue(pick argPick) func([]byte) (int, bool) {
	return func(b []byte) (int, bool) {
		if len(b) == 0 {
			return -2, false
		}
		if !isBlank(b[0]) {
			return -1, false // the command's name goes on ("mysqld", "sshpass-x"), it is not this command
		}
		for i := 0; ; {
			for i < len(b) && isBlank(b[i]) {
				i++
			}
			switch {
			case i >= len(b):
				return -2, false
			case cmdEnd(b[i]) || i > maxCmdScan:
				return -1, false
			}
			switch v := pick(b, i); {
			case v == -2:
				return -2, false
			case v >= 0:
				return v, true
			}
			e := wordEnd(b, i)
			if e == -2 {
				return -2, false
			}
			i = e
		}
	}
}

// isWordAt: the word at b[i] is exactly s (followed by a blank, a command end or the buffer's end, which needs more bytes: -2 from the caller's point of view is not needed here, an exact match
// at the buffer's end is simply not yet a flag with a value).
func isWordAt(b []byte, i int, s string) bool {
	if len(b)-i < len(s) || string(b[i:i+len(s)]) != s {
		return false
	}
	return i+len(s) == len(b) || isBlank(b[i+len(s)])
}

// attachedP is the pick of a program whose password is attached to -p ("-pSecret", "-p'a b'"): the value after "-p", when something follows it; a bare "-p" asks on the terminal.
func attachedP(b []byte, i int) int {
	if len(b)-i < 3 || b[i] != '-' || b[i+1] != 'p' {
		return -1
	}
	if isBlank(b[i+2]) || cmdEnd(b[i+2]) {
		return -1
	}
	return valueAt(b, i+2)
}

// pAsWord is the pick of a program that takes -p either attached or as the next word (sshpass): "-p hunter2", "-p 'a b'", "-phunter2".
func pAsWord(b []byte, i int) int {
	if v := attachedP(b, i); v >= 0 {
		return v
	}
	if isWordAt(b, i, "-p") {
		return nextWordValue(b, i+2)
	}
	return -1
}

// flagThenWord is the pick of "flag value" for the given flags (redis-cli -a, docker login -p / --password).
func flagThenWord(flags ...string) argPick {
	return func(b []byte, i int) int {
		for _, f := range flags {
			if isWordAt(b, i, f) {
				return nextWordValue(b, i+len(f))
			}
		}
		return -1
	}
}

// userColonPassword is curl's "-u user:password" / "--user user:password": the value starts after the first colon of the next word; a user with no colon is asked for its password.
func userColonPassword(b []byte, i int) int {
	for _, f := range []string{"-u", "--user"} {
		if !isWordAt(b, i, f) {
			continue
		}
		j := i + len(f)
		for j < len(b) && isBlank(b[j]) {
			j++
		}
		if j >= len(b) {
			return -2
		}
		if cmdEnd(b[j]) {
			return -1
		}
		start := valueAt(b, j)
		e := wordEnd(b, j)
		if e == -2 {
			return -2
		}
		for k := start; k < e; k++ {
			if b[k] == ':' {
				return k + 1
			}
		}
		return -1
	}
	return -1
}

// passPrefixed is openssl's "-passin pass:secret" (and -passout, -pass): the value after "pass:" in the next word.
func passPrefixed(b []byte, i int) int {
	for _, f := range []string{"-passin", "-passout", "-pass"} {
		if !isWordAt(b, i, f) {
			continue
		}
		j := i + len(f)
		for j < len(b) && isBlank(b[j]) {
			j++
		}
		if len(b)-j < len("pass:") {
			if j >= len(b) || string(b[j:]) == "pass:"[:len(b)-j] {
				return -2
			}
			return -1
		}
		if string(b[j:j+5]) == "pass:" && j+5 < len(b) && !isBlank(b[j+5]) {
			return valueAt(b, j+5)
		}
		return -1
	}
	return -1
}

// longFlagGlue: after "--password" (or --passwd, --pass, --pwd, --token, --api-key and the like), "=value" or blanks and the value; the next byte being anything else ("--password-stdin",
// "--token-file", "--passthrough") is another flag, not this one. A value that begins with "-" in the blank form is the next flag.
func longFlagGlue(b []byte) (int, bool) {
	if len(b) == 0 {
		return -2, false
	}
	switch {
	case b[0] == '=':
		if len(b) == 1 {
			return -2, false
		}
		if isBlank(b[1]) || cmdEnd(b[1]) {
			return -1, false
		}
		return valueAt(b, 1), true
	case isBlank(b[0]):
		v := nextWordValue(b, 0)
		return v, v >= 0
	}
	return -1, false
}

// slackWebhookGlue: after "hooks.slack.com/services/", the two path ids (T..., B...) and their slashes; the secret is the third part.
func slackWebhookGlue(b []byte) (int, bool) {
	i := 0
	for part := 0; part < 2; part++ {
		start := i
		for i < len(b) && (b[i] >= 'A' && b[i] <= 'Z' || b[i] >= '0' && b[i] <= '9') {
			i++
		}
		switch {
		case i == len(b):
			return -2, false
		case i == start || b[i] != '/':
			return -1, false
		}
		i++
	}
	if i >= len(b) {
		return -2, false
	}
	return i, true
}

// withSuffix lets a glue take, right after its prefix, one of the suffixes that complete a name ("mysql" + "dump", "--pass" + "word"): the rules' prefixes never nest (a prefix that is the start of another
// would be decided before the longer one has arrived on a stream), so the longer names are one prefix and a suffix.
func withSuffix(suffixes []string, glue func([]byte) (int, bool)) func([]byte) (int, bool) {
	return func(b []byte) (int, bool) {
		for _, suf := range suffixes {
			if len(b) >= len(suf) && string(b[:len(suf)]) == suf {
				n, ok := glue(b[len(suf):])
				if n >= 0 {
					n += len(suf)
				}
				return n, ok
			}
			if len(b) < len(suf) && string(b) == suf[:len(b)] {
				return -2, false // the suffix may still be arriving
			}
		}
		return glue(b)
	}
}

// The command-line rules, appended to tokenRules after the original nine (rules before them keep their places: redact_secretnames.go names two by index). No prefix is the start of another.
var cliRules = []tokenRule{
	{prefixes: []string{"sshpass"}, glue: argGlue(pAsWord), class: isSecretValue, min: 1, max: 512, keep: true, notAfter: isWord, toQuote: true},
	{prefixes: []string{"mysql"}, glue: withSuffix([]string{"dump", "admin", "import", "check"}, argGlue(attachedP)), class: isSecretValue, min: 1, max: 512, keep: true, notAfter: isWord, toQuote: true},
	{prefixes: []string{"mariadb"}, glue: withSuffix([]string{"-dump", "-admin"}, argGlue(attachedP)), class: isSecretValue, min: 1, max: 512, keep: true, notAfter: isWord, toQuote: true},
	{prefixes: []string{"redis-cli"}, glue: argGlue(flagThenWord("-a")), class: isSecretValue, min: 1, max: 512, keep: true, notAfter: isWord, toQuote: true},
	{prefixes: []string{"docker login", "podman login"}, glue: argGlue(flagThenWord("-p", "--password")), class: isSecretValue, min: 1, max: 512, keep: true, notAfter: isWord, toQuote: true},
	{prefixes: []string{"curl"}, glue: argGlue(userColonPassword), class: isSecretValue, min: 1, max: 512, keep: true, notAfter: isWord, toQuote: true},
	{prefixes: []string{"openssl"}, glue: argGlue(passPrefixed), class: isSecretValue, min: 1, max: 512, keep: true, notAfter: isWord, toQuote: true},
	{prefixes: longPasswordFlags, glue: withSuffix([]string{"word", "wd", "phrase"}, longFlagGlue), class: isSecretValue, min: 1, max: 512, keep: true, notAfter: isWord, toQuote: true},
	{prefixes: []string{"npm_"}, class: isAlnum, min: 36, max: 255, notAfter: isWord},
	{prefixes: []string{"hooks.slack.com/services/"}, glue: slackWebhookGlue, class: isAlnum, min: 20, max: 255, keep: true, notAfter: isWord},
}

// longPasswordFlags are the long flags that carry a secret ("--pass" also stands for --password, --passwd and --passphrase: withSuffix).
var longPasswordFlags = []string{"--pass", "--pwd", "--secret", "--client-secret", "--token", "--auth-token", "--access-token", "--api-key", "--apikey"}
