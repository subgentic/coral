package routes

import (
	"bufio"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// #16015: the $ menu also lists the skills the person has in their own folders and the ones in the agent's working folder, each marked with where it comes from. It reads names and descriptions only:
// the front matter of each SKILL.md, a few KB of it, never the body, never a script, and nothing is run or attached. A link (a skills folder, a skill's folder or its SKILL.md), a folder name that is not a plain
// name and anything outside the two roots is refused. The text is the skill author's, so it is cleaned and cut like every other description.

const (
	maxLocalMenuSkills = 40       // the menu lists at most this many of the person's and the repo's together
	maxSkillMDRead     = 16 << 10 // bytes read of one SKILL.md: the front matter is at the top
	maxFrontMatter     = 60       // lines of front matter read
	sourceCoral        = "coral"  // the approved skills of Coral's Skills Store
	sourceYou          = "you"    // the person's own folders in their home folder
	sourceRepo         = "repo"   // the agent's working folder
	localDescMax       = 140
)

// localSkillRoots are the folders, under the home folder or the agent's folder, where an agent CLI keeps skills.
var (
	homeSkillRoots = []string{".claude/skills", ".codex/skills", ".agents/skills"}
	repoSkillRoots = []string{".claude/skills", ".agents/skills"}
)

var plainSkillName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// localSkills lists the skills under base/<root> for each root, in the order of the roots. base must be an absolute folder that is not itself a link.
func localSkills(base string, roots []string, source string, room int) []skillSummary {
	var out []skillSummary
	if room <= 0 || base == "" || !filepath.IsAbs(base) {
		return nil
	}
	if fi, err := os.Lstat(base); err != nil || !fi.IsDir() { // not a folder, or a link: the folder is not read
		return nil
	}
	seen := map[string]bool{}
	for _, root := range roots {
		dir, ok := plainSubfolder(base, strings.Split(root, "/"))
		if !ok {
			continue
		}
		entries, ok := readSomeEntries(dir, dirEntryCap)
		if !ok {
			continue
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		for _, e := range entries {
			if len(out) >= room {
				return out
			}
			if !e.IsDir() || e.Type()&os.ModeSymlink != 0 || !plainSkillName.MatchString(e.Name()) { // a link, a file or an odd name
				continue
			}
			name, desc, ok := readFrontMatter(filepath.Join(dir, e.Name(), "SKILL.md"))
			if !ok {
				continue
			}
			if !plainSkillName.MatchString(name) {
				name = e.Name()
			}
			if seen[name] {
				continue
			}
			seen[name] = true
			out = append(out, skillSummary{Name: name, Description: noteLine(desc, localDescMax), Source: source})
		}
	}
	return out
}

// dirEntryCap is how many entries of one skills folder a call reads (a var so a test can lower it): a huge folder costs a bounded read, and the menu has room for 40 skills anyway (#16083).
var dirEntryCap = 500

// readSomeEntries lists at most max entries of a folder, without reading the rest of it, sorted by name.
func readSomeEntries(dir string, max int) ([]os.DirEntry, bool) {
	f, err := os.Open(dir)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	entries, err := f.ReadDir(max)
	if err != nil && err != io.EOF {
		return nil, false
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	return entries, true
}

// plainSubfolder walks down from base one name at a time, refusing a link or a non-folder at every step: the result is inside base.
func plainSubfolder(base string, parts []string) (string, bool) {
	cur := base
	for _, p := range parts {
		cur = filepath.Join(cur, p)
		fi, err := os.Lstat(cur)
		if err != nil || !fi.IsDir() || fi.Mode()&os.ModeSymlink != 0 {
			return "", false
		}
	}
	return cur, true
}

// readFrontMatter reads the name and the description from the top of a SKILL.md (a regular file, not a link) and nothing else. ok is false when the file is not there, not a regular file or has no front matter.
func readFrontMatter(path string) (name, desc string, ok bool) {
	fi, err := os.Lstat(path)
	if err != nil || !fi.Mode().IsRegular() {
		return "", "", false
	}
	f, err := os.Open(path)
	if err != nil {
		return "", "", false
	}
	defer f.Close()
	sc := bufio.NewScanner(io.LimitReader(f, maxSkillMDRead))
	sc.Buffer(make([]byte, 0, 4096), maxSkillMDRead)
	if !sc.Scan() || strings.TrimSpace(strings.TrimPrefix(sc.Text(), "\ufeff")) != "---" {
		return "", "", false
	}
	var lines []string
	for sc.Scan() && len(lines) < maxFrontMatter {
		if strings.TrimSpace(sc.Text()) == "---" {
			break
		}
		lines = append(lines, sc.Text())
	}
	for i := 0; i < len(lines); i++ {
		key, val, found := strings.Cut(lines[i], ":")
		if !found || strings.HasPrefix(lines[i], " ") || strings.HasPrefix(lines[i], "\t") {
			continue
		}
		val = strings.TrimSpace(val)
		switch strings.TrimSpace(key) {
		case "name":
			name = unquoteYAML(val)
		case "description":
			if val == ">" || val == "|" || val == ">-" || val == "|-" { // a block: the indented lines under it
				var parts []string
				for i+1 < len(lines) && (strings.HasPrefix(lines[i+1], " ") || strings.HasPrefix(lines[i+1], "\t")) {
					i++
					parts = append(parts, strings.TrimSpace(lines[i]))
				}
				desc = strings.Join(parts, " ")
			} else {
				desc = unquoteYAML(val)
			}
		}
	}
	return name, desc, true
}

func unquoteYAML(v string) string {
	if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
		v = v[1 : len(v)-1]
		v = strings.NewReplacer(`\"`, `"`, `\\`, `\`, `\n`, " ").Replace(v)
	}
	return v
}

// matchesWords is the menu route's search for the local skills: every word is in the name or the description.
func matchesWords(s skillSummary, q string) bool {
	hay := strings.ToLower(s.Name + " " + s.Description)
	for _, w := range strings.Fields(strings.ToLower(q)) {
		if !strings.Contains(hay, w) {
			return false
		}
	}
	return true
}
