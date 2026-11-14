package dropbox

// Share via Dropbox (#14944, design v3, the Operator's approval of mock v4 on #197874): the calls that make a copy to share and share it with
// specific people (view only), with the Dropbox team by link, or with anyone who has the link; read a file's links again; and stop sharing. Through
// the same gated client as backup (only Dropbox's API hosts); errors carry Dropbox's tag only. A link Dropbox answers is used only when ValidLink
// accepts it (Security's condition 7), and is never logged by this package.

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"
)

var (
	// ErrMissingScope: the sign-in predates sharing (it lacks sharing.write or sharing.read). Sign in again; backup keeps working meanwhile.
	ErrMissingScope = errors.New("this Dropbox sign-in does not allow sharing")
	// ErrLinkExists: the file already has a link of its own; read it with SharedLinks.
	ErrLinkExists = errors.New("the file already has a shared link")
	// ErrLinkSettings: the account's plan refuses these link settings (an expiry on a basic account, a team link off a team).
	ErrLinkSettings = errors.New("this Dropbox plan does not allow these link settings")
	// ErrBadLink: Dropbox answered a link Coral will not show (not https on www.dropbox.com).
	ErrBadLink = errors.New("Dropbox answered a link Coral does not show")
)

// Audience is who can open a shared link.
type Audience string

// The two link audiences Coral makes. Specific people are not a link: see AddFileMembers.
const (
	AudiencePublic Audience = "public" // anyone with the link
	AudienceTeam   Audience = "team"   // members of the person's Dropbox team with the link
)

// Account is what sharing needs to know about the signed-in account: a basic (free) one cannot set a link's expiry, and only a team member gets a
// team choice (named by the team's name).
type Account struct {
	AccountID string
	Basic     bool
	TeamName  string
}

// CurrentAccount reads the signed-in account (users/get_current_account).
func (c *Client) CurrentAccount(ctx context.Context, access string) (Account, error) {
	var out struct {
		AccountID   string `json:"account_id"`
		AccountType struct {
			Tag string `json:".tag"`
		} `json:"account_type"`
		Team *struct {
			Name string `json:"name"`
		} `json:"team"`
	}
	if err := c.rpc(ctx, access, "users/get_current_account", nil, &out); err != nil {
		return Account{}, err
	}
	a := Account{AccountID: out.AccountID, Basic: out.AccountType.Tag == "basic"}
	if out.Team != nil {
		a.TeamName = cleanTeamName(out.Team.Name)
		if a.TeamName == "" {
			a.TeamName = "your team"
		}
	}
	return a, nil
}

// cleanTeamName keeps a team's name printable and short for the dialog (it is shown as text, never as markup).
func cleanTeamName(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) || (r >= 0x200b && r <= 0x200f) || (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069) || r == 0xfeff {
			continue
		}
		b.WriteRune(r)
	}
	out := strings.TrimSpace(b.String())
	if r := []rune(out); len(r) > 60 {
		out = string(r[:60]) + "…"
	}
	return out
}

// Copy copies the file at from to to inside Dropbox (files/copy_v2), never over a file there (no autorename: a taken name is the caller's to
// suffix), and returns the copy's metadata. The caller checks the copy's content hash before sharing it (Security's condition 5).
func (c *Client) Copy(ctx context.Context, access, from, to string) (Meta, error) {
	var out struct {
		Metadata struct {
			Tag         string `json:".tag"`
			ID          string `json:"id"`
			Rev         string `json:"rev"`
			ContentHash string `json:"content_hash"`
		} `json:"metadata"`
	}
	arg := map[string]any{"from_path": from, "to_path": to, "autorename": false, "allow_ownership_transfer": false}
	if err := c.rpc(ctx, access, "files/copy_v2", arg, &out); err != nil {
		return Meta{}, err
	}
	if out.Metadata.Tag != "file" || out.Metadata.Rev == "" {
		return Meta{}, errors.New("Dropbox: the copy is not a file")
	}
	return Meta{FileID: out.Metadata.ID, Rev: out.Metadata.Rev, ContentHash: out.Metadata.ContentHash}, nil
}

// Link is a shared link as Coral shows it: the URL (checked), who can open it, and when it expires (zero: never).
type Link struct {
	URL      string
	Audience Audience
	Expires  time.Time
}

type linkAnswer struct {
	URL             string `json:"url"`
	Expires         string `json:"expires"`
	LinkPermissions struct {
		ResolvedVisibility struct {
			Tag string `json:".tag"`
		} `json:"resolved_visibility"`
		EffectiveAudience struct {
			Tag string `json:".tag"`
		} `json:"effective_audience"`
	} `json:"link_permissions"`
}

func (a linkAnswer) link() (Link, error) {
	if !ValidLink(a.URL) {
		return Link{}, ErrBadLink
	}
	l := Link{URL: a.URL, Audience: AudiencePublic}
	switch a.LinkPermissions.EffectiveAudience.Tag {
	case "public":
	case "team":
		l.Audience = AudienceTeam
	case "":
		if v := a.LinkPermissions.ResolvedVisibility.Tag; v == "team_only" || v == "team_and_password" {
			l.Audience = AudienceTeam
		}
	default: // an audience Coral does not make (no_one, members, password, a new one): Coral cannot say who can open it, so it is not shown
		return Link{}, ErrBadLink
	}
	if a.Expires != "" {
		t, err := time.Parse(time.RFC3339, a.Expires)
		if err != nil {
			return Link{}, ErrBadLink
		}
		l.Expires = t
	}
	return l, nil
}

// CreateLink makes a link to the file at path for the audience, view only, expiring at expires when it is not zero
// (sharing/create_shared_link_with_settings). ErrLinkExists when the file has one already, ErrLinkSettings when the plan refuses the settings.
func (c *Client) CreateLink(ctx context.Context, access, path string, aud Audience, expires time.Time) (Link, error) {
	if aud != AudiencePublic && aud != AudienceTeam {
		return Link{}, errors.New("a link is for the public or the team")
	}
	settings := map[string]any{"audience": map[string]string{".tag": string(aud)}, "access": map[string]string{".tag": "viewer"}, "allow_download": true}
	if !expires.IsZero() {
		settings["expires"] = expires.UTC().Truncate(time.Second).Format("2006-01-02T15:04:05Z")
	}
	var out linkAnswer
	if err := c.rpc(ctx, access, "sharing/create_shared_link_with_settings", map[string]any{"path": path, "settings": settings}, &out); err != nil {
		return Link{}, sharingError(err)
	}
	return out.link()
}

// SharedLinks reads the links of the file at path itself (sharing/list_shared_links, direct_only), the newest Dropbox lists first.
func (c *Client) SharedLinks(ctx context.Context, access, path string) ([]Link, error) {
	var out struct {
		Links []linkAnswer `json:"links"`
	}
	if err := c.rpc(ctx, access, "sharing/list_shared_links", map[string]any{"path": path, "direct_only": true}, &out); err != nil {
		return nil, sharingError(err)
	}
	var links []Link
	for _, a := range out.Links {
		if l, err := a.link(); err == nil {
			links = append(links, l)
		}
	}
	return links, nil
}

// CanShare checks, before anything is made, that this sign-in allows sharing: a read of the account's links (sharing/list_shared_links with no
// path, which needs sharing.read). ErrMissingScope for an older sign-in.
func (c *Client) CanShare(ctx context.Context, access string) error {
	var out struct {
		Links []json.RawMessage `json:"links"`
	}
	return sharingError(c.rpc(ctx, access, "sharing/list_shared_links", map[string]any{}, &out))
}

// RevokeLink revokes a link (sharing/revoke_shared_link). A link Dropbox no longer has is already revoked: nil.
func (c *Client) RevokeLink(ctx context.Context, access, link string) error {
	if !ValidLink(link) {
		return ErrBadLink
	}
	err := c.rpc(ctx, access, "sharing/revoke_shared_link", map[string]string{"url": link}, nil)
	if err != nil && (errors.Is(err, ErrNotFound) || strings.Contains(err.Error(), "shared_link_not_found")) {
		return nil
	}
	return sharingError(err)
}

// AddFileMembers shares the file (by its id) with people by email, view only (sharing/add_file_member). Dropbox sends them its own invitation.
// A member Dropbox refuses fails the whole call with its tag; the caller then stops sharing what was added.
func (c *Client) AddFileMembers(ctx context.Context, access, fileID string, emails []string) error {
	if !strings.HasPrefix(fileID, "id:") {
		return errors.New("sharing with people needs the copy's file id")
	}
	if len(emails) == 0 || len(emails) > MaxMembers {
		return errors.New("share with 1 to 20 people")
	}
	type member struct {
		Tag   string `json:".tag"`
		Email string `json:"email"`
	}
	ms := make([]member, 0, len(emails))
	for _, e := range emails {
		ms = append(ms, member{Tag: "email", Email: e})
	}
	var out []struct {
		Result struct {
			Tag string `json:".tag"`
		} `json:"result"`
	}
	arg := map[string]any{"file": fileID, "members": ms, "quiet": false, "access_level": map[string]string{".tag": "viewer"}, "add_message_as_comment": false}
	if err := c.rpc(ctx, access, "sharing/add_file_member", arg, &out); err != nil {
		return sharingError(err)
	}
	for _, r := range out {
		if t := r.Result.Tag; t != "success" && t != "" {
			if !validTag(t) {
				t = "unknown"
			}
			return errors.New("Dropbox: a member was not added: " + t)
		}
	}
	return nil
}

// MaxMembers is how many people one share adds.
const MaxMembers = 20

// UnshareFile removes every member the file was shared with (sharing/unshare_file). A file that is not shared, or gone, needs nothing: nil.
func (c *Client) UnshareFile(ctx context.Context, access, fileID string) error {
	err := c.rpc(ctx, access, "sharing/unshare_file", map[string]string{"file": fileID}, nil)
	if err != nil && (errors.Is(err, ErrNotFound) || strings.Contains(err.Error(), "invalid_file") || strings.Contains(err.Error(), "not_found")) {
		return nil
	}
	return sharingError(err)
}

// sharingError names the sharing refusals a caller tells apart.
func sharingError(err error) error {
	if err == nil {
		return nil
	}
	s := err.Error()
	switch {
	case strings.Contains(s, "missing_scope"):
		return ErrMissingScope
	case strings.Contains(s, "shared_link_already_exists"):
		return ErrLinkExists
	case strings.Contains(s, "settings_error"):
		return ErrLinkSettings
	}
	return err
}

// ValidLink accepts only a link Coral may show, copy or open (Security's condition 7): https, the host www.dropbox.com exactly, no user or port,
// and a shared-link path (/scl/ or /s/).
func ValidLink(s string) bool {
	if len(s) > 2048 || strings.ContainsAny(s, " \t\r\n\\\"'<>`") {
		return false
	}
	u, err := url.Parse(s)
	if err != nil || u.Scheme != "https" || u.Host != "www.dropbox.com" || u.User != nil || u.Opaque != "" || u.Fragment != "" {
		return false
	}
	return strings.HasPrefix(u.Path, "/scl/") || strings.HasPrefix(u.Path, "/s/")
}

// FolderMemberEmails reads the addresses of the people in the shared folders this account has (sharing/list_folders, then sharing/list_folder_members for the first maxFolders
// of them; sharing.read, which Coral already holds), for the share dialog's suggestions (#16170). Dropbox has no call that lists a person's contacts (the contacts namespace
// only deletes them), so this is the nearest thing under the scopes Coral has. One page of each, no more; a folder that cannot be read is skipped. Nothing is stored here.
func (c *Client) FolderMemberEmails(ctx context.Context, access string, maxFolders int) ([]string, error) {
	var folders struct {
		Entries []struct {
			ID string `json:"shared_folder_id"`
		} `json:"entries"`
	}
	if err := c.rpc(ctx, access, "sharing/list_folders", map[string]any{"limit": maxFolders}, &folders); err != nil {
		return nil, sharingError(err)
	}
	var out []string
	seen := map[string]bool{}
	for i, f := range folders.Entries {
		if i >= maxFolders {
			break
		}
		var members struct {
			Users []struct {
				User struct {
					Email string `json:"email"`
				} `json:"user"`
			} `json:"users"`
			Invitees []struct {
				Invitee struct {
					Email string `json:"email"`
				} `json:"invitee"`
			} `json:"invitees"`
		}
		if err := c.rpc(ctx, access, "sharing/list_folder_members", map[string]any{"shared_folder_id": f.ID, "limit": 50}, &members); err != nil {
			continue
		}
		add := func(e string) {
			if e = strings.ToLower(strings.TrimSpace(e)); e != "" && !seen[e] {
				seen[e] = true
				out = append(out, e)
			}
		}
		for _, u := range members.Users {
			add(u.User.Email)
		}
		for _, v := range members.Invitees {
			add(v.Invitee.Email)
		}
	}
	return out, nil
}
