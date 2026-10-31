// Package sshprov is the self-hosted hub's way onto another computer over SSH, to set a Coral server up there (#11370). This file: who to connect to. A target is user@host[:port] typed by the
// owner, or a Host entry of the hub user's own ~/.ssh/config; both are validated strictly before anything is run, because the pieces end up in the argv of the system ssh.
package sshprov

import (
	"errors"
	"net"
	"regexp"
	"strconv"
	"strings"
)

// Target is a validated place to connect to. Alias is set when it came from ~/.ssh/config (ssh resolves the rest itself, with the user's own settings); User, Host and Port are set otherwise.
type Target struct {
	Alias string
	User  string
	Host  string
	Port  int
}

var (
	userRe  = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
	labelRe = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)
	aliasRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
)

// ErrBadTarget is every refusal of ParseTarget: the text says what was wrong, never echoing the input as markup.
var ErrBadTarget = errors.New("not a valid SSH target")

// ParseTarget reads "user@host", "user@host:port" or "user@[v6]:port". The user is required (no guessing from the hub's own account), the host is a DNS name or an IP literal, and nothing that
// ssh could read as an option (a leading "-"), a shell could read as syntax, or a control character is accepted.
func ParseTarget(s string) (Target, error) {
	user, rest, ok := strings.Cut(s, "@")
	if !ok || !userRe.MatchString(user) {
		return Target{}, errors.Join(ErrBadTarget, errors.New("write it as user@host or user@host:port (the user in lower case letters, digits, _ and -)"))
	}
	host, port := rest, 22
	switch {
	case strings.HasPrefix(rest, "["):
		h, p, found := strings.Cut(strings.TrimPrefix(rest, "["), "]")
		if !found {
			return Target{}, errors.Join(ErrBadTarget, errors.New("an IPv6 address is written [address]"))
		}
		host = h
		if p != "" {
			n, err := parsePort(strings.TrimPrefix(p, ":"), strings.HasPrefix(p, ":"))
			if err != nil {
				return Target{}, err
			}
			port = n
		}
		if ip := net.ParseIP(host); ip == nil || ip.To4() != nil || strings.Contains(host, "%") {
			return Target{}, errors.Join(ErrBadTarget, errors.New("that is not an IPv6 address"))
		}
	default:
		if h, p, found := strings.Cut(rest, ":"); found {
			n, err := parsePort(p, true)
			if err != nil {
				return Target{}, err
			}
			host, port = h, n
		}
		if !validHostName(host) {
			return Target{}, errors.Join(ErrBadTarget, errors.New("the host is a DNS name or an IP address"))
		}
	}
	return Target{User: user, Host: host, Port: port}, nil
}

func parsePort(p string, present bool) (int, error) {
	n, err := strconv.Atoi(p)
	if !present || err != nil || n < 1 || n > 65535 || strconv.Itoa(n) != p {
		return 0, errors.Join(ErrBadTarget, errors.New("the port is a number from 1 to 65535"))
	}
	return n, nil
}

func validHostName(h string) bool {
	if h == "" || len(h) > 253 {
		return false
	}
	if ip := net.ParseIP(h); ip != nil {
		return ip.To4() != nil // an IPv6 literal must be bracketed; a zone ("%eth0") never parses here
	}
	for _, l := range strings.Split(h, ".") {
		if !labelRe.MatchString(l) {
			return false
		}
	}
	return true
}

// FromAlias is the target for a Host entry of ~/.ssh/config the owner picked. The name must be one ConfigHosts listed (the caller checks), and is still validated here: it becomes an argument of ssh.
func FromAlias(alias string) (Target, error) {
	if !aliasRe.MatchString(alias) {
		return Target{}, errors.Join(ErrBadTarget, errors.New("that is not a Host name from your SSH config"))
	}
	return Target{Alias: alias}, nil
}

// Destination is the one argument ssh takes for where to go, always after "--".
func (t Target) Destination() string {
	if t.Alias != "" {
		return t.Alias
	}
	h := t.Host
	if strings.Contains(h, ":") {
		h = "[" + h + "]"
	}
	return t.User + "@" + strings.Trim(h, "[]")
}

// Args are the ssh options that carry the target's port, or none for an alias (its own entry says).
func (t Target) Args() []string {
	if t.Alias != "" {
		return nil
	}
	return []string{"-p", strconv.Itoa(t.Port)}
}

// String is the target as the owner reads it in the plan they confirm.
func (t Target) String() string {
	if t.Alias != "" {
		return t.Alias + " (from your SSH config)"
	}
	return t.Destination() + ":" + strconv.Itoa(t.Port)
}
