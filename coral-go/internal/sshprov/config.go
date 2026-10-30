package sshprov

import (
	"bufio"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// maxConfigBytes bounds what is read of the config: a picker does not need more, and a huge file is not an SSH config.
const maxConfigBytes = 1 << 20

// ConfigHosts lists the Host names of the SSH config at path (the hub user's own ~/.ssh/config; the caller names it, this reads that file only). It returns concrete names only: a pattern
// (* ? !), a name ssh would reject as an argument, and anything under Match are skipped, and an Include is NOT followed. Nothing in the file is run, and nothing is copied out but the names.
func ConfigHosts(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()
	var names []string
	seen := map[string]bool{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 4096), 64*1024)
	read := 0
	for sc.Scan() {
		read += len(sc.Bytes()) + 1
		if read > maxConfigBytes {
			break
		}
		line := strings.TrimSpace(sc.Text())
		key, val, ok := splitDirective(line)
		if !ok || !strings.EqualFold(key, "Host") {
			continue
		}
		for _, n := range strings.Fields(val) {
			if strings.HasPrefix(n, "#") {
				break
			}
			if strings.ContainsAny(n, "*?!") || !aliasRe.MatchString(n) || seen[n] {
				continue
			}
			seen[n] = true
			names = append(names, n)
		}
	}
	sort.Strings(names)
	return names, sc.Err()
}

// DefaultConfigPath is the hub user's ~/.ssh/config.
func DefaultConfigPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".ssh", "config")
}

// splitDirective splits "Key value" and "Key=value".
func splitDirective(line string) (key, val string, ok bool) {
	if line == "" || strings.HasPrefix(line, "#") {
		return "", "", false
	}
	i := strings.IndexAny(line, " \t=")
	if i <= 0 {
		return "", "", false
	}
	return line[:i], strings.TrimLeft(line[i:], " \t="), true
}
