package skills

import (
	"regexp"
	"sort"
	"strings"
)

// Warning is one thing a script does that the Operator should look at twice. A scanner is a warning, never a guarantee: the Operator's reading is the control.
type Warning struct {
	File string `json:"file"`
	Rule string `json:"rule"`
}

type scanRule struct {
	name string
	re   *regexp.Regexp
}

var scanRules = []scanRule{
	{"pipes a download into a shell", regexp.MustCompile(`(?i)\b(curl|wget|fetch)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b`)},
	{"decodes text and runs it", regexp.MustCompile(`(?i)\b(base64|openssl\s+enc)\b[^|\n]*(-d|--decode)[^|\n]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b`)},
	{"evaluates a command's output", regexp.MustCompile(`(?i)\beval\s+["']?\$\(|\bsource\s+<\(`)},
	{"reads keys, credentials or secrets", regexp.MustCompile(`(?i)(~|\$HOME|\$\{HOME\})/\.(ssh|aws|gnupg|kube|docker|netrc|config/gcloud|config/gh)|\bid_(rsa|ed25519|ecdsa)\b|\.env\b|\bcredentials\b|\bsecrets?\.(json|ya?ml|txt)\b`)},
	{"removes files recursively", regexp.MustCompile(`\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+)?(-[a-zA-Z]*[fF][a-zA-Z]*\s+)?(-[a-zA-Z]*[rR][a-zA-Z]*|-rf|-fr)\b|\brm\s+-rf?\b`)},
	{"changes permissions widely or runs as root", regexp.MustCompile(`\bchmod\s+(-R\s+)?[0-7]*7[0-7]*7\b|\bsudo\b`)},
	{"opens a network connection", regexp.MustCompile(`(?i)\b(nc|ncat|netcat|socat)\b\s+-?[a-z]*\s*\S+\s+\d+|/dev/tcp/`)},
}

var hostRe = regexp.MustCompile(`(?i)\bhttps?://([a-z0-9][a-z0-9.-]{0,253}[a-z0-9])(:[0-9]{1,5})?`)

// ScanResult is what the scanner found in a skill's scripts.
type ScanResult struct {
	Warnings []Warning `json:"warnings"`
	Hosts    []string  `json:"hosts"` // every host a script names
}

// Scan reads the scripts of sk (and any other file with a shebang) for the patterns that are worth a second look. Files that are not scripts are not scanned: a reference file may say anything.
func Scan(sk *Skill) ScanResult {
	res := ScanResult{Warnings: []Warning{}, Hosts: []string{}}
	hosts := map[string]bool{}
	seen := map[Warning]bool{}
	for _, f := range sk.Files {
		if f.Kind != KindScript {
			continue
		}
		text := string(sk.Content[f.Path])
		for _, r := range scanRules {
			if r.re.MatchString(text) {
				if w := (Warning{File: f.Path, Rule: r.name}); !seen[w] {
					seen[w] = true
					res.Warnings = append(res.Warnings, w)
				}
			}
		}
		for _, m := range hostRe.FindAllStringSubmatch(text, -1) {
			hosts[strings.ToLower(m[1])] = true
		}
	}
	for h := range hosts {
		res.Hosts = append(res.Hosts, h)
	}
	sort.Strings(res.Hosts)
	sort.Slice(res.Warnings, func(i, j int) bool {
		if res.Warnings[i].File != res.Warnings[j].File {
			return res.Warnings[i].File < res.Warnings[j].File
		}
		return res.Warnings[i].Rule < res.Warnings[j].Rule
	})
	return res
}
