package hubowner

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// One Coral reached by two hubs (#21213, multi-Hub goal #269): each hub installs its own secret, kept per hub link, so a second hub's install never replaces the first's. A hub that says which link it is
// (the hub id it installs with, and LinkHeader on each stamp it signs) is checked against its own secret only. The single file of before (FileName) stays what it was: the link of a hub that installed
// without a hub id (an older hub), read as a link with no hub id, so an upgrade breaks no link that works today.

// LinksFileName holds the secrets of the hubs that installed with a hub id: a JSON list, written and read like FileName (0600, never through a link).
const LinksFileName = "hub_owner_links"

// LinkHeader carries the hub id of the hub that signed a stamp. It names the secret to check, nothing more: the stamp's MAC is what proves the hub.
const LinkHeader = "X-Coral-Hub-Link"

// LinksVersion is what a remote's health answer says (hub_owner_links) when it keeps one secret per hub: a hub sends its hub id with the secret it installs only to a remote that says so, since an older
// remote refuses the field.
const LinksVersion = 1

// MaxLinks is how many hubs one Coral keeps a secret for.
const MaxLinks = 16

const maxLinksFile = 16 << 10

// Link is one hub's secret on this Coral. Hub is "" for the single file of an older hub's install.
type Link struct {
	Hub    string `json:"hub"`
	Name   string `json:"name,omitempty"`
	Remote string `json:"remote"`
	Secret string `json:"secret"`
	At     string `json:"at"`
}

// Label is how the remote names the link to a person: the hub's name, else the id the hub knows this computer by.
func (l Link) Label() string {
	if l.Name != "" {
		return l.Name
	}
	return l.Remote
}

// ValidHubID is a hub's link id: 8 to 64 lower case letters, digits and dashes.
func ValidHubID(id string) bool {
	if len(id) < 8 || len(id) > 64 {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-') {
			return false
		}
	}
	return true
}

// CleanHubName is a hub's name as a person may be shown it: trimmed, at most 64 characters, letters, digits, punctuation and plain spaces only. "" when nothing is left.
func CleanHubName(s string) string {
	s = strings.TrimSpace(s)
	if !utf8.ValidString(s) {
		return ""
	}
	var b strings.Builder
	n := 0
	for _, r := range s {
		if n == 64 {
			break
		}
		if r == ' ' || unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsPunct(r) {
			b.WriteRune(r)
			n++
		}
	}
	return strings.TrimSpace(b.String())
}

// Links is every hub secret this Coral holds: the single file's (Hub "") first, then the hubs that installed with a hub id. A file that is there but not usable is an error (the caller refuses every stamp).
func Links(dir string) ([]Link, error) {
	var out []Link
	if id, secret, ok, err := ReadFile(dir); err != nil {
		return nil, err
	} else if ok {
		at := ""
		if fi, err := os.Lstat(filepath.Join(dir, FileName)); err == nil {
			at = fi.ModTime().UTC().Truncate(time.Second).Format(time.RFC3339)
		}
		out = append(out, Link{Remote: id, Secret: secret, At: at})
	}
	more, err := readLinks(dir)
	if err != nil {
		return nil, err
	}
	return append(out, more...), nil
}

// Leftover is the single-file secret of an older hub's install that a hub with its own link now shadows: it names this computer the same way a link does, so it is most likely that hub's old secret, still
// accepted until someone removes it (Install with a hub id leaves the single file alone, #21213). ok is false when there is no single file, or no link holds the same computer name (#21251).
func Leftover(dir string) (Link, bool) {
	links, err := Links(dir)
	if err != nil || len(links) == 0 || links[0].Hub != "" {
		return Link{}, false
	}
	for _, l := range links[1:] {
		if l.Remote == links[0].Remote {
			return links[0], true
		}
	}
	return Link{}, false
}

// LeftoverNote is the line a person is shown about a leftover single-file secret.
func LeftoverNote(l Link) string {
	return "a leftover older secret under the same computer name as a hub's link: it still works; run coral hub-owner-secret --remove " + l.Remote + " to end it"
}

func readLinks(dir string) ([]Link, error) {
	b, ok, err := readPrivate(dir, LinksFileName, maxLinksFile)
	if err != nil || !ok {
		return nil, err
	}
	var ls []Link
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&ls); err != nil || len(ls) > MaxLinks {
		return nil, fmt.Errorf("hubowner: %s is not a list of hub secrets", LinksFileName)
	}
	seen := map[string]bool{}
	for _, l := range ls {
		if !ValidHubID(l.Hub) || !ValidRemoteID(l.Remote) || !ValidSecret(l.Secret) || CleanHubName(l.Name) != l.Name || seen[l.Hub] {
			return nil, fmt.Errorf("hubowner: %s is not a list of hub secrets", LinksFileName)
		}
		seen[l.Hub] = true
	}
	return ls, nil
}

// Install keeps a hub's secret (a person's act, like WriteFile). With no hub id it is WriteFile: an older hub's install, which replaces the single file as before. With a hub id it adds that hub's link or
// replaces only that hub's. The single file is never touched by it: an older hub may know this computer by the same name, and nothing proves the file was this hub's (QA SHOULD 3), so it stays until the
// person removes it (coral hub-owner-secret --remove).
func Install(dir string, l Link, now time.Time) error {
	if l.Hub == "" {
		return WriteFile(dir, l.Remote, l.Secret)
	}
	if !ValidHubID(l.Hub) || !ValidRemoteID(l.Remote) || !ValidSecret(l.Secret) {
		return errors.New("hubowner: not a valid hub id, remote id and secret")
	}
	l.Name = CleanHubName(l.Name)
	l.At = now.UTC().Truncate(time.Second).Format(time.RFC3339)
	ls, err := readLinks(dir)
	if err != nil {
		return err
	}
	kept := ls[:0]
	for _, o := range ls {
		if o.Hub != l.Hub {
			kept = append(kept, o)
		}
	}
	if len(kept) >= MaxLinks {
		return fmt.Errorf("hubowner: this computer already holds secrets for %d hubs: remove one first (coral hub-owner-secret --remove)", MaxLinks)
	}
	return writeLinks(dir, append(kept, l))
}

func writeLinks(dir string, ls []Link) error {
	if len(ls) == 0 {
		err := os.Remove(filepath.Join(dir, LinksFileName))
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	b, err := json.Marshal(ls)
	if err != nil {
		return err
	}
	return writePrivate(dir, LinksFileName, string(b)+"\n")
}

// Remove drops the secret of one link: the hub id of a hub that installed with one, or the computer id of the single file. It says how many went (0 when none matched).
func Remove(dir, key string) (int, error) {
	n := 0
	if id, _, ok, err := ReadFile(dir); err != nil {
		return 0, err
	} else if ok && id == key {
		if err := os.Remove(filepath.Join(dir, FileName)); err != nil {
			return 0, err
		}
		n++
	}
	ls, err := readLinks(dir)
	if err != nil {
		return n, err
	}
	kept := ls[:0]
	for _, l := range ls {
		if l.Hub == key {
			n++
			continue
		}
		kept = append(kept, l)
	}
	if len(kept) == len(ls) {
		return n, nil
	}
	return n, writeLinks(dir, kept)
}

// Reasons a stamp is refused, for the refusal's detail code and the remote's log. The remote's answer names the reason and the hub; the log adds the link, never a secret.
const (
	ReasonStale       = "stale"        // too old or too new for the clocks, or made before this Coral started
	ReasonWrongSecret = "wrong_secret" // no secret this Coral holds for that hub made it
	ReasonReplay      = "replay"       // already used
	ReasonNoSecret    = "no_secret"    // this Coral holds no hub's secret
	ReasonUnknownLink = "unknown_link" // the hub named a link this Coral holds no secret for
	ReasonMalformed   = "malformed"    // not a stamp, not a route that takes one, or a body too large
)

// LinkVerifiers checks stamps against every link's secret, each with its own replay table. The zero value is ready.
type LinkVerifiers struct {
	// Start is when this process started (Verifier.Start); Now is the clock, nil for time.Now.
	Start time.Time
	Now   func() time.Time
	m     map[string]*Verifier // by hub id, remote id and secret: a rotated secret gets a new table
}

// Check verifies a stamp. hub is the LinkHeader value ("" when the hub sent none: an older hub, checked against every secret). It returns the link that made the stamp, or the reason it is refused and the
// link it was checked against when there was exactly one.
func (lv *LinkVerifiers) Check(links []Link, hub, value, method, decodedPath, target string, body []byte) (*Link, string, *Link) {
	return lv.check(links, hub, false, value, method, decodedPath, target, body)
}

// CheckExact is Check for a request that arrived on one hub's own key link (#21261): hub is that link's recorded hub id and only the secret held under exactly that id can make the stamp. There is no
// fallback to the single file of an older hub's install and no "every secret" for an empty id: another link's secret, or none, is refused (ReasonUnknownLink or ReasonNoSecret).
func (lv *LinkVerifiers) CheckExact(links []Link, hub, value, method, decodedPath, target string, body []byte) (*Link, string, *Link) {
	if !ValidHubID(hub) {
		return nil, ReasonUnknownLink, nil
	}
	return lv.check(links, hub, true, value, method, decodedPath, target, body)
}

func (lv *LinkVerifiers) check(links []Link, hub string, exact bool, value, method, decodedPath, target string, body []byte) (*Link, string, *Link) {
	if lv.m == nil {
		lv.m = map[string]*Verifier{}
	}
	var cands []Link
	if hub != "" {
		for _, l := range links {
			if l.Hub == hub {
				cands = []Link{l}
				break
			}
		}
		if cands == nil && !exact { // a hub that installed before it said its id has its secret in the single file
			for _, l := range links {
				if l.Hub == "" {
					cands = append(cands, l)
				}
			}
		}
	} else {
		cands = links
	}
	if len(cands) == 0 {
		if len(links) == 0 {
			return nil, ReasonNoSecret, nil
		}
		return nil, ReasonUnknownLink, nil
	}
	// every link held keeps its verifier and replay table, whichever hub this stamp is from (Security's MUST on da39815989: a check for hub A must not drop hub B's table); only a removed or
	// rotated link's table goes
	key := func(l Link) string { return l.Hub + "\x00" + l.Remote + "\x00" + l.Secret }
	live := make(map[string]*Verifier, len(links))
	for _, l := range links {
		v := lv.m[key(l)]
		if v == nil {
			v = &Verifier{Secret: l.Secret, RemoteID: l.Remote, Start: lv.Start, Now: lv.Now}
		}
		live[key(l)] = v
	}
	lv.m = live
	var errs []error
	var ok *Link
	for i := range cands {
		l := cands[i]
		err := live[key(l)].Verify(value, method, decodedPath, target, body)
		if err == nil {
			ok = &l
			break
		}
		errs = append(errs, err)
	}
	if ok != nil {
		return ok, "", nil
	}
	var one *Link
	if len(cands) == 1 {
		one = &cands[0]
	}
	return nil, reasonOf(errs), one
}

func reasonOf(errs []error) string {
	has := func(want error) bool {
		for _, e := range errs {
			if errors.Is(e, want) {
				return true
			}
		}
		return false
	}
	switch {
	case has(ErrMalformed) || has(ErrRoute) || has(ErrBody):
		return ReasonMalformed
	case has(ErrReplay):
		return ReasonReplay
	case has(ErrStale):
		return ReasonStale
	case has(ErrNoSecret):
		return ReasonNoSecret
	}
	return ReasonWrongSecret
}

// HubIDFileName holds the id this Coral, as a hub, installs its secrets on other computers with and sends with its stamps (LinkHeader): made once, kept, not a secret.
const HubIDFileName = "hub_link_id"

// HubID is this hub's link id, made on first use (32 random hex digits) and kept in dir.
func HubID(dir string) (string, error) {
	if b, ok, err := readPrivate(dir, HubIDFileName, 128); err != nil {
		return "", err
	} else if ok {
		if id := strings.TrimSpace(string(b)); ValidHubID(id) {
			return id, nil
		}
		return "", fmt.Errorf("hubowner: %s is not a hub id", HubIDFileName)
	}
	s, err := NewSecret()
	if err != nil {
		return "", err
	}
	id := s[:32]
	if err := writePrivate(dir, HubIDFileName, id+"\n"); err != nil {
		return "", err
	}
	return id, nil
}
