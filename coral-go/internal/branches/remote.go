package branches

import (
	"context"
	"net/url"
	"regexp"
	"strings"
)

// The repository's remote (origin), as the tab shows it and as PR state is asked for (Security's #6804 point 4): parsed, never matched by a pattern over the whole text. Three shapes are
// read, https://[user[:token]@]host/owner/repo[.git], ssh://[user@]host[:port]/owner/repo[.git] and the scp form user@host:owner/repo[.git]; anything else is an unknown remote. Only
// the host and owner/repo are kept: no user, no token, no query or fragment. It is text to show, never a link.

// Remote is a repository's origin as host and owner/repo.
type Remote struct {
	Host  string `json:"host"`
	Owner string `json:"owner"`
	Name  string `json:"name"`
}

var (
	remotePart = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)
	remoteHost = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$`)
	scpForm    = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}@([^:/]+):(.+)$`)
)

// parseRemote is raw's host and owner/repo, or false.
func parseRemote(raw string) (Remote, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 400 || strings.ContainsAny(raw, " \t\r\n\x00") {
		return Remote{}, false
	}
	var host, path string
	if m := scpForm.FindStringSubmatch(raw); m != nil && !strings.Contains(raw, "://") {
		host, path = m[1], m[2]
	} else {
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "https" && u.Scheme != "ssh") || u.Opaque != "" {
			return Remote{}, false
		}
		host, path = u.Hostname(), u.Path
	}
	host = strings.ToLower(host)
	if !remoteHost.MatchString(host) {
		return Remote{}, false
	}
	parts := strings.Split(strings.Trim(strings.TrimSuffix(path, ".git"), "/"), "/")
	if len(parts) != 2 || !remotePart.MatchString(parts[0]) || !remotePart.MatchString(parts[1]) || parts[1] == "." || parts[1] == ".." {
		return Remote{}, false
	}
	return Remote{Host: host, Owner: parts[0], Name: parts[1]}, true
}

// remoteOf reads the origin's URL of the repository at root from its own config (no network): parsed, or false.
func (c *Collector) remoteOf(ctx context.Context, root string) (Remote, bool) {
	out, err := c.run(ctx, root, "config", "--get", "remote.origin.url")
	if err != nil {
		return Remote{}, false
	}
	return parseRemote(string(out))
}
