// Package skills reads an Agent Skills folder sent as a zip (SKILL.md plus scripts/, references/, assets/) the way the Skills Store stores it (#12020, goal #191): archive safety, the front
// matter, and what each file is (instructions, a script, plain text, or something that cannot be shown as text). It stores nothing; the store package keeps the rows.
package skills

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

// The limits of a skill. Decompressed sizes are counted as the bytes are read: a header's size is never trusted.
const (
	MaxZipBytes       = 5 << 20
	MaxUnpackedBytes  = 20 << 20
	MaxFiles          = 100
	MaxFileBytes      = 1 << 20
	MaxSkillMDBytes   = 100 << 10
	maxFrontMatter    = 8 << 10
	maxFrontKeys      = 32
	maxYAMLDepth      = 4
	MaxDescriptionLen = 1024
	MaxNameLen        = 64
	maxCompatibility  = 500
	maxMetadataPairs  = 32
	maxMetadataLen    = 256
)

// ErrInvalid is every refusal: Error() says what was wrong in words that carry nothing of the archive but a path or a limit.
var ErrInvalid = errors.New("skills: not a valid skill")

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, a...))
}

// NameRe is the Agent Skills spec's name: lower case letters and digits, single hyphens between.
var NameRe = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// Kind is what a file is, for the approval view.
type Kind string

const (
	KindInstructions  Kind = "instructions"   // SKILL.md
	KindScript        Kind = "script"         // run by an agent with its permissions
	KindText          Kind = "text"           // shown in full
	KindNotReviewable Kind = "not_reviewable" // cannot be shown as text (an image, a binary): counts like a script at approval
)

// File is one file of the skill.
type File struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	Kind   Kind   `json:"kind"`
	SHA256 string `json:"sha256"`
}

// Skill is a parsed skill.
type Skill struct {
	// Digest is the SHA-256 (hex) of the zip bytes Parse read: the store refuses a skill whose digest is not the one it is given with it.
	Digest        string
	Name          string
	Description   string
	License       string
	Compatibility string
	AllowedTools  string
	Metadata      map[string]string
	Body          string // SKILL.md after its front matter
	Files         []File
	// Content is the bytes of each instructions, script and text file by path (not the files that cannot be shown as text): what get serves and the approval view shows.
	Content map[string][]byte
}

// Tags is metadata.tags split at commas.
func (s *Skill) Tags() []string {
	var out []string
	for _, t := range strings.Split(s.Metadata["tags"], ",") {
		if t = strings.TrimSpace(t); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// Scripts and NotReviewable count the files that need the second click at approval.
func (s *Skill) Scripts() (n int) {
	for _, f := range s.Files {
		if f.Kind == KindScript {
			n++
		}
	}
	return
}
func (s *Skill) NotReviewable() (n int) {
	for _, f := range s.Files {
		if f.Kind == KindNotReviewable {
			n++
		}
	}
	return
}

var scriptExt = map[string]bool{".sh": true, ".bash": true, ".zsh": true, ".fish": true, ".py": true, ".rb": true, ".pl": true, ".js": true, ".mjs": true, ".cjs": true, ".ts": true, ".ps1": true,
	".bat": true, ".cmd": true, ".exe": true, ".dll": true, ".so": true, ".dylib": true, ".jar": true, ".php": true, ".lua": true, ".awk": true}

// Parse reads a skill from a zip of at most MaxZipBytes. The folder may be at the top of the archive or in one folder named like the skill.
func Parse(data []byte) (*Skill, error) {
	if len(data) == 0 || len(data) > MaxZipBytes {
		return nil, invalid("the zip must be between 1 byte and %d MiB", MaxZipBytes>>20)
	}
	whole := sha256.Sum256(data)
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, invalid("that is not a zip file")
	}
	if len(zr.File) > MaxFiles*2 { // folders count here; files are counted below
		return nil, invalid("too many entries")
	}
	type entry struct {
		name string
		f    *zip.File
	}
	var entries []entry
	seen := map[string]bool{}
	for _, f := range zr.File {
		name := f.Name
		if strings.ContainsAny(name, "\\\x00") || strings.HasPrefix(name, "/") || hasControl(name) || !utf8.ValidString(name) {
			return nil, invalid("a file name is not allowed: %q", clip(name))
		}
		isDir := strings.HasSuffix(name, "/")
		clean := path.Clean(strings.TrimSuffix(name, "/"))
		if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || strings.Contains(clean, "/../") || len(clean) > 200 {
			return nil, invalid("a file path leaves the folder: %q", clip(name))
		}
		for _, part := range strings.Split(clean, "/") {
			if strings.HasPrefix(part, ".") {
				return nil, invalid("a hidden file or folder is not allowed: %q", clip(name))
			}
		}
		if f.Mode()&(fs.ModeSymlink|fs.ModeDevice|fs.ModeNamedPipe|fs.ModeSocket|fs.ModeCharDevice|fs.ModeIrregular) != 0 {
			return nil, invalid("a link or special file is not allowed: %q", clip(name))
		}
		key := strings.ToLower(clean)
		if seen[key] {
			return nil, invalid("two entries have the same name (case aside): %q", clip(name))
		}
		seen[key] = true
		if !isDir {
			entries = append(entries, entry{clean, f})
		}
	}
	if len(entries) == 0 {
		return nil, invalid("the zip has no files")
	}
	if len(entries) > MaxFiles {
		return nil, invalid("too many files (at most %d)", MaxFiles)
	}
	// The root: SKILL.md at the top, or every file under one folder.
	prefix := ""
	if _, top := find(entries, "SKILL.md", func(e entry) string { return e.name }); !top {
		first, _, _ := strings.Cut(entries[0].name, "/")
		for _, e := range entries {
			if f, _, ok := strings.Cut(e.name, "/"); !ok || f != first {
				return nil, invalid("SKILL.md must be at the top, or every file must be inside one folder")
			}
		}
		prefix = first + "/"
		if _, ok := find(entries, prefix+"SKILL.md", func(e entry) string { return e.name }); !ok {
			return nil, invalid("there is no SKILL.md")
		}
	}
	var total int64
	sk := &Skill{Digest: hex.EncodeToString(whole[:]), Content: map[string][]byte{}}
	var skillMD []byte
	sort.Slice(entries, func(i, j int) bool { return entries[i].name < entries[j].name })
	for _, e := range entries {
		rel := strings.TrimPrefix(e.name, prefix)
		rc, err := e.f.Open()
		if err != nil {
			return nil, invalid("a file could not be read: %q", clip(rel))
		}
		// Counted as read: a header that says 10 bytes and holds a gigabyte stops at the cap, and a nested archive is only ever bytes here, never opened.
		limit := int64(MaxFileBytes)
		if rel == "SKILL.md" {
			limit = MaxSkillMDBytes
		}
		b, err := io.ReadAll(io.LimitReader(rc, limit+1))
		rc.Close()
		if err != nil {
			return nil, invalid("a file could not be read: %q", clip(rel))
		}
		if int64(len(b)) > limit {
			return nil, invalid("%q is over its size limit", clip(rel))
		}
		total += int64(len(b))
		if total > MaxUnpackedBytes {
			return nil, invalid("the files are over %d MiB together", MaxUnpackedBytes>>20)
		}
		sum := sha256.Sum256(b)
		file := File{Path: rel, Size: int64(len(b)), SHA256: hex.EncodeToString(sum[:])}
		switch {
		case rel == "SKILL.md":
			file.Kind = KindInstructions
			skillMD = b
		case isScript(rel, b, e.f.Mode()):
			file.Kind = KindScript
		case isText(b):
			file.Kind = KindText
		default:
			file.Kind = KindNotReviewable
		}
		if file.Kind != KindNotReviewable {
			sk.Content[rel] = b
		}
		sk.Files = append(sk.Files, file)
	}
	if err := parseSkillMD(sk, skillMD); err != nil {
		return nil, err
	}
	if prefix != "" && strings.TrimSuffix(prefix, "/") != sk.Name {
		return nil, invalid("the folder is named %q but the skill is %q", clip(strings.TrimSuffix(prefix, "/")), sk.Name)
	}
	return sk, nil
}

func find[T any](xs []T, want string, name func(T) string) (T, bool) {
	var zero T
	for _, x := range xs {
		if name(x) == want {
			return x, true
		}
	}
	return zero, false
}

// hasControl reports a control character or an invisible one: any C0 or C1 control, and every format (Cf), line-separator (Zl) and paragraph-separator (Zp) character, which takes in the
// reordering and zero-width characters and the whole tag block ("ASCII smuggling"): none can be in a name, a front matter field or a file the Operator is shown.
func hasControl(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) || unicode.In(r, unicode.Cf, unicode.Zl, unicode.Zp) {
			return true
		}
	}
	return false
}

// agentExt are the extensions a skill an agent publishes may hold besides SKILL.md: documents and data.
var agentExt = map[string]bool{".md": true, ".txt": true, ".json": true, ".yaml": true, ".yml": true, ".csv": true, ".toml": true}

// AgentMayPublish reports whether every file of sk is SKILL.md or a document or data file: an agent's skill holds nothing else in v1 (the rule is a form test, not a guarantee: the Operator's
// reading is the control).
func AgentMayPublish(sk *Skill) bool {
	for _, f := range sk.Files {
		if f.Path == "SKILL.md" {
			continue
		}
		if f.Kind != KindText || !agentExt[strings.ToLower(path.Ext(f.Path))] {
			return false
		}
	}
	return true
}

func clip(s string) string {
	if utf8.RuneCountInString(s) > 60 {
		return string([]rune(s)[:60]) + "…"
	}
	return s
}

func isScript(rel string, b []byte, mode fs.FileMode) bool {
	if strings.HasPrefix(rel, "scripts/") || scriptExt[strings.ToLower(path.Ext(rel))] || bytes.HasPrefix(b, []byte("#!")) {
		return true
	}
	return mode.Perm()&0o111 != 0
}

// isText is a file that can be shown as text: valid UTF-8, no NUL, no other control characters but the usual white space.
func isText(b []byte) bool {
	if !utf8.Valid(b) {
		return false
	}
	for _, r := range string(b) {
		if r < 0x20 && r != '\n' && r != '\r' && r != '\t' || r == 0x7f || (r >= 0x80 && r < 0xa0) || unicode.In(r, unicode.Cf, unicode.Zl, unicode.Zp) {
			return false
		}
	}
	return true
}

// parseSkillMD reads the front matter with a YAML reader that refuses anchors, aliases, tags, duplicate keys and depth, then checks the fields against the spec.
func parseSkillMD(sk *Skill, md []byte) error {
	if !isText(md) {
		return invalid("SKILL.md holds a control or invisible character (zero-width, reordering or tag characters are not allowed)")
	}
	text := strings.ReplaceAll(string(md), "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return invalid("SKILL.md must start with a --- front matter")
	}
	rest := text[4:]
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return invalid("the front matter in SKILL.md is not closed with ---")
	}
	front := rest[:end]
	if len(front) > maxFrontMatter {
		return invalid("the front matter is over %d KiB", maxFrontMatter>>10)
	}
	body := rest[end+4:]
	if i := strings.Index(body, "\n"); i >= 0 {
		body = body[i+1:]
	} else {
		body = ""
	}
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(front), &doc); err != nil || len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return invalid("the front matter is not a YAML mapping")
	}
	root := doc.Content[0]
	if err := safeNode(root, 0); err != nil {
		return err
	}
	if len(root.Content)/2 > maxFrontKeys {
		return invalid("too many front matter keys")
	}
	fields := map[string]*yaml.Node{}
	for i := 0; i+1 < len(root.Content); i += 2 {
		k := root.Content[i]
		if k.Kind != yaml.ScalarNode {
			return invalid("a front matter key is not text")
		}
		if _, dup := fields[k.Value]; dup {
			return invalid("the front matter repeats the key %q", clip(k.Value))
		}
		fields[k.Value] = root.Content[i+1]
	}
	str := func(key string, max int, required bool) (string, error) {
		n, ok := fields[key]
		if !ok {
			if required {
				return "", invalid("the front matter has no %s", key)
			}
			return "", nil
		}
		if n.Kind != yaml.ScalarNode {
			return "", invalid("%s must be text", key)
		}
		v := strings.TrimSpace(n.Value)
		if required && v == "" {
			return "", invalid("%s is empty", key)
		}
		if utf8.RuneCountInString(v) > max {
			return "", invalid("%s is over %d characters", key, max)
		}
		if hasControl(strings.ReplaceAll(v, "\n", " ")) {
			return "", invalid("%s has a control character", key)
		}
		return v, nil
	}
	var err error
	if sk.Name, err = str("name", MaxNameLen, true); err != nil {
		return err
	}
	if !NameRe.MatchString(sk.Name) {
		return invalid("the name must be lower case letters, digits and single hyphens")
	}
	if sk.Description, err = str("description", MaxDescriptionLen, true); err != nil {
		return err
	}
	if sk.License, err = str("license", 200, false); err != nil {
		return err
	}
	if sk.Compatibility, err = str("compatibility", maxCompatibility, false); err != nil {
		return err
	}
	if sk.AllowedTools, err = str("allowed-tools", 500, false); err != nil {
		return err
	}
	sk.Metadata = map[string]string{}
	if m, ok := fields["metadata"]; ok {
		if m.Kind != yaml.MappingNode || len(m.Content)/2 > maxMetadataPairs {
			return invalid("metadata must be a short mapping of text to text")
		}
		for i := 0; i+1 < len(m.Content); i += 2 {
			k, v := m.Content[i], m.Content[i+1]
			if k.Kind != yaml.ScalarNode || v.Kind != yaml.ScalarNode || utf8.RuneCountInString(k.Value) > 64 || utf8.RuneCountInString(v.Value) > maxMetadataLen || hasControl(k.Value+v.Value) {
				return invalid("metadata must be a short mapping of text to text")
			}
			if _, dup := sk.Metadata[k.Value]; dup {
				return invalid("metadata repeats the key %q", clip(k.Value))
			}
			sk.Metadata[k.Value] = v.Value
		}
	}
	sk.Body = body
	return nil
}

// safeNode refuses anchors, aliases, explicit tags and nesting deeper than maxYAMLDepth.
func safeNode(n *yaml.Node, depth int) error {
	if depth > maxYAMLDepth {
		return invalid("the front matter is nested too deeply")
	}
	if n.Anchor != "" || n.Kind == yaml.AliasNode || n.Alias != nil {
		return invalid("the front matter may not use anchors or aliases")
	}
	if n.Style&yaml.TaggedStyle != 0 {
		return invalid("the front matter may not use tags")
	}
	for _, c := range n.Content {
		if err := safeNode(c, depth+1); err != nil {
			return err
		}
	}
	return nil
}
