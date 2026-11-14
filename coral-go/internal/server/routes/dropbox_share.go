package routes

// Share via Dropbox (#14944, design v3, mock v4 approved by the Operator on #197874), the server. An artifact is shared as a COPY in
// /Shared from Coral/<team>/<name>, separate from the backup (retention, removal and Free up space never touch it), with specific people by email
// (the default), with the person's Dropbox team by link, or with anyone who has the link; always view only. Security's conditions (design v3):
//   1. this computer's Operator only (shareCaller: never the Hub's owner, a Hub reader, a guide, an agent or a tunnel), refuseCloud on every route;
//   2. nothing is created before the press, and a link needs confirm in the request;
//   3. the name recipients see is the one the dialog showed, cleaned here again;
//   4. a file the secrets check flags needs secret_ok before a link;
//   5. the copy's content hash must equal the bytes' own (and the ledger's); otherwise it is deleted and the share refused;
//   7. a link is shown only when dropbox.ValidLink accepts it, and is never stored, logged or posted (read again from Dropbox when shown);
//   8. Stop sharing removes the people and revokes every link of the copy first; only then is the copy deleted, at its rev;
//   10. 20 shares an hour, the backup path's size cap, one audit row a share and a stop (a word and counts only).
// The chat page (condition 6) and the Disconnect, Rekey and Switch guards (condition 9) are later pieces.

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/mail"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/cliauth"
	"github.com/subgentic/coral/internal/dropbox"
	"github.com/subgentic/coral/internal/httputil"
	"github.com/subgentic/coral/internal/store"
)

// signInAgainText is the answer when Dropbox says this sign-in may not share: the Coral app in the Dropbox App Console needs sharing.write and
// sharing.read, and a sign-in made before they were added must be made again (#198059: the app lacked them in the Operator's walk).
const signInAgainText = "Dropbox does not allow this sign-in to share. In the Dropbox App Console, the Coral app needs the sharing.write and sharing.read permissions; then sign in to Dropbox again."

const (
	shareRoot       = "/Shared from Coral"
	shareExpiry     = 30 * 24 * time.Hour
	shareStaleAfter = 15 * time.Minute // a share left preparing or stopping this long is undone by the cleanup
	shareNameMax    = 120              // bytes of the file name recipients see
	shareFolderMax  = 60               // bytes of the team's folder name
)

// shareCaller is who may share (Security's condition 1): the Operator's own dashboard on this computer (with or without its cookie) or the
// signed command line whose signature was checked. Never a session token (an agent), a guide, the Hub's owner or any other Hub reader.
func shareCaller(r *http.Request) bool {
	if r.Header.Get(store.SessionTokenHeader) != "" {
		return false
	}
	if _, ok := r.Context().Value(verifiedSessionKey{}).(*store.SessionTokenOwner); ok {
		return false
	}
	if isGuideCaller(r) {
		return false
	}
	switch kind, _ := r.Context().Value(callerKindKey{}).(string); kind {
	case callerDashCookie, callerDashNoCookie:
		return true
	case callerCLISigned:
		return cliauth.Verified(r)
	}
	return false
}

// shareGate is every share route's first check: this computer, the Operator, a backup in this build.
func (h *CloudHandler) shareGate(w http.ResponseWriter, r *http.Request) (*DropboxBackup, bool) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) {
		return nil, false
	}
	if !shareCaller(r) {
		writeError(w, http.StatusForbidden, "operator_only", "Only you can share, from this computer's dashboard")
		return nil, false
	}
	if h.dbx == nil || h.dbx.backup == nil {
		writeError(w, http.StatusNotFound, "not_available", "Dropbox is not available in this build")
		return nil, false
	}
	return h.dbx.backup, true
}

// cleanShareName is the file name recipients see (condition 3): no path separators, control or format characters, no leading dots, no
// reserved Windows names, trimmed, capped, and ending in the file's own extension. "" when nothing usable is left.
func cleanShareName(name, ext string) string {
	name = strings.Map(func(r rune) rune {
		switch {
		case r == '/' || r == '\\' || r == ':' || r == '*' || r == '?' || r == '"' || r == '<' || r == '>' || r == '|':
			return '-'
		case r < 0x20 || r == 0x7f || unicode.Is(unicode.Cf, r) || unicode.Is(unicode.Co, r) || r == utf8.RuneError:
			return -1
		}
		return r
	}, name)
	name = strings.Join(strings.Fields(name), " ")
	name = strings.TrimLeft(name, ". ")
	name = strings.TrimRight(name, ". ")
	if ext != "" && !strings.HasPrefix(ext, ".") {
		ext = "." + ext
	}
	base := name
	if ext != "" && strings.HasSuffix(strings.ToLower(name), strings.ToLower(ext)) {
		base = name[:len(name)-len(ext)]
	}
	base = strings.TrimRight(base, ". ")
	for len(base)+len(ext) > shareNameMax {
		_, size := utf8.DecodeLastRuneInString(base)
		base = base[:len(base)-size]
	}
	base = strings.TrimRight(base, ". ")
	if base == "" {
		return ""
	}
	stem := strings.ToUpper(strings.SplitN(base, ".", 2)[0])
	switch stem {
	case "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
		"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9":
		base = "_" + base
	}
	return base + ext
}

// shareFolder is the team's folder under /Shared from Coral, cleaned like a name; "Coral" when there is no team.
func shareFolder(team string) string {
	f := cleanShareName(team, "")
	for len(f) > shareFolderMax {
		_, size := utf8.DecodeLastRuneInString(f)
		f = strings.TrimRight(f[:len(f)-size], ". ")
	}
	if f == "" {
		return "Coral"
	}
	return f
}

// withSuffix is name with " (n)" before its extension.
func withSuffix(name string, n int) string {
	ext := path.Ext(name)
	if ext == name {
		ext = ""
	}
	return strings.TrimSuffix(name, ext) + " (" + strconv.Itoa(n) + ")" + ext
}

// shareEmails checks the people to share with: plain addresses only (no display name, no list in one entry), lower-cased, no duplicates, 1 to 20.
func shareEmails(in []string) ([]string, error) {
	seen := map[string]bool{}
	var out []string
	for _, e := range in {
		e = strings.TrimSpace(e)
		if e == "" {
			continue
		}
		a, err := mail.ParseAddress(e)
		if err != nil || a.Name != "" || a.Address != e || len(e) > 254 || strings.ContainsAny(e, ",;<> \t\r\n\"'") {
			return nil, errors.New("one of the addresses is not an email address")
		}
		e = strings.ToLower(e)
		if !seen[e] {
			seen[e] = true
			out = append(out, e)
		}
	}
	if len(out) == 0 || len(out) > dropbox.MaxMembers {
		return nil, errors.New("share with 1 to 20 people")
	}
	return out, nil
}

// shareSource is what an artifact share starts from: its verified bytes, the name and team it was uploaded with, and its version.
type shareSource struct {
	data    []byte
	name    string
	ext     string
	team    string
	version int
}

func (b *DropboxBackup) shareSourceOf(digest string) (shareSource, error) {
	data, err := b.readObject(digest) // no-follow, a regular file, capped at the backup's size, SHA-256 checked
	if err != nil {
		return shareSource{}, err
	}
	src := shareSource{data: data}
	for _, rec := range recordsOfDigest(b.coralDir, digest) {
		if src.name == "" {
			src.name, src.team, src.version = rec.rec.Name, rec.rec.Board, rec.rec.Version
			src.ext = path.Ext(rec.rec.Name)
			if src.ext == "" {
				src.ext = dropboxExtOf(rec.rec.MediaType)
			}
		}
	}
	if src.name == "" {
		src.name = "shared file"
	}
	if src.version < 1 {
		src.version = 1
	}
	return src, nil
}

// isPrivate reads the artifact's private mark; an error is not "not private" (fail closed).
func (b *DropboxBackup) isPrivate(ctx context.Context, digest string) (bool, error) {
	if b.private == nil {
		return false, nil
	}
	m, err := b.private(ctx, []string{digest})
	if err != nil {
		return true, err
	}
	return m[digest], nil
}

// DropboxShareInfo answers GET /api/dropbox/share/{digest}: what the dialog needs before anything is shared (the proposed name, size, version,
// whether the plan can expire a link, the team's name when there is one, whether the file looks like it holds a secret) and the file's live
// shares, with their links read again from Dropbox.
func (h *CloudHandler) DropboxShareInfo(w http.ResponseWriter, r *http.Request) {
	b, ok := h.shareGate(w, r)
	if !ok {
		return
	}
	digest := chi.URLParam(r, "digest")
	if !dropboxDigestRe.MatchString(digest) {
		errBadRequest(w, "not an artifact id")
		return
	}
	ctx := r.Context()
	if priv, err := b.isPrivate(ctx, digest); err != nil || priv {
		writeError(w, http.StatusForbidden, "private", "A private file is not shared")
		return
	}
	src, err := b.shareSourceOf(digest)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "Coral does not have this file")
		return
	}
	cl, access, account, err := b.dropboxAccess(ctx)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"connected": false})
		return
	}
	acct, err := cl.CurrentAccount(ctx, access)
	if err != nil || acct.AccountID != account {
		writeError(w, http.StatusBadGateway, "dropbox", "Could not read your Dropbox account; try again")
		return
	}
	out := map[string]any{
		"connected": true, "name": cleanShareName(src.name, src.ext), "size": len(src.data), "version": src.version,
		"can_expire": !acct.Basic, "team": acct.TeamName, "secret": b.secret != nil && b.secret(src.data),
		"folder": shareRoot + "/" + shareFolder(src.team),
	}
	shares, err := b.outbox.SharesOf(ctx, digest)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not read the shares")
		return
	}
	var list []map[string]any
	for _, sh := range shares {
		list = append(list, b.shareView(ctx, cl, access, account, sh))
	}
	out["shares"] = list
	writeJSON(w, http.StatusOK, out)
}

// shareView is one share as the dialog and Settings show it: its link only when Dropbox still has one for the copy and it passes ValidLink.
func (b *DropboxBackup) shareView(ctx context.Context, cl *dropbox.Client, access, account string, sh store.DropboxShare) map[string]any {
	v := map[string]any{"id": sh.ID, "name": path.Base(sh.Path), "folder": path.Dir(sh.Path), "audience": sh.Audience, "people": sh.People,
		"state": sh.State, "created_at": sh.CreatedAt, "expires_at": sh.ExpiresAt}
	if sh.AccountID != account {
		v["other_account"] = true
		return v
	}
	if sh.State == store.DropboxShareLive && sh.Audience != store.DropboxSharePeople && cl != nil {
		if links, err := cl.SharedLinks(ctx, access, sh.Path); err == nil && len(links) > 0 {
			v["link"] = links[0].URL
		} else if errors.Is(err, dropbox.ErrMissingScope) {
			v["sign_in_again"] = true
		}
	}
	return v
}

type shareRequest struct {
	Name     string   `json:"name"`
	Audience string   `json:"audience"` // people, team or public
	Emails   []string `json:"emails"`
	Expire   bool     `json:"expire"`    // 30 days, where the plan allows
	Confirm  bool     `json:"confirm"`   // the press (condition 2)
	SecretOK bool     `json:"secret_ok"` // the second confirm for a flagged file (condition 4)
}

// DropboxShare answers POST /api/dropbox/share/{digest}: copy the artifact to /Shared from Coral/<team>/<name> and share it.
func (h *CloudHandler) DropboxShare(w http.ResponseWriter, r *http.Request) {
	b, ok := h.shareGate(w, r)
	if !ok || !requireJSON(w, r) {
		return
	}
	digest := chi.URLParam(r, "digest")
	if !dropboxDigestRe.MatchString(digest) {
		errBadRequest(w, "not an artifact id")
		return
	}
	var in shareRequest
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	if err := decodeJSONStrict(r, &in); err != nil {
		errBadRequest(w, "not a share request")
		return
	}
	if !in.Confirm {
		writeError(w, http.StatusBadRequest, "confirm_required", "Sharing needs your press in the dialog")
		return
	}
	var emails []string
	switch in.Audience {
	case store.DropboxSharePeople:
		var err error
		if emails, err = shareEmails(in.Emails); err != nil {
			writeError(w, http.StatusBadRequest, "emails", err.Error())
			return
		}
	case store.DropboxShareTeam, store.DropboxSharePublic:
		if len(in.Emails) > 0 {
			errBadRequest(w, "a link is not shared with people by email")
			return
		}
	default:
		errBadRequest(w, "share with people, your team or anyone with the link")
		return
	}
	ctx := r.Context()
	if priv, err := b.isPrivate(ctx, digest); err != nil || priv {
		writeError(w, http.StatusForbidden, "private", "A private file is not shared")
		return
	}
	src, err := b.shareSourceOf(digest)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "Coral does not have this file, or it is over the size Dropbox backup takes")
		return
	}
	name := cleanShareName(in.Name, src.ext)
	if name == "" {
		writeError(w, http.StatusBadRequest, "name", "Give the file a name recipients will see")
		return
	}
	if in.Audience != store.DropboxSharePeople && b.secret != nil && b.secret(src.data) && !in.SecretOK {
		writeError(w, http.StatusConflict, "secret_confirm", "This file looks like it contains a key or token")
		return
	}
	cl, access, account, err := b.dropboxAccess(ctx)
	if err != nil {
		writeError(w, http.StatusConflict, "not_connected", "Connect Dropbox first")
		return
	}
	acct, err := cl.CurrentAccount(ctx, access)
	if err != nil || acct.AccountID != account {
		writeError(w, http.StatusBadGateway, "dropbox", "Could not read your Dropbox account; try again")
		return
	}
	if in.Audience == store.DropboxShareTeam && acct.TeamName == "" {
		writeError(w, http.StatusBadRequest, "no_team", "This Dropbox account is not in a team")
		return
	}
	var expires time.Time
	if in.Expire && !acct.Basic && in.Audience != store.DropboxSharePeople {
		expires = b.clock().Add(shareExpiry).UTC().Truncate(time.Second)
	}
	res, code, refusal := b.share(ctx, cl, access, account, store.DropboxShareArtifact, digest, src, name, in.Audience, emails, expires)
	if refusal != nil {
		writeShareRefusal(w, code, refusal)
		return
	}
	if in.Expire && acct.Basic && in.Audience != store.DropboxSharePeople {
		res["expiry"] = "Expiry is not available on this Dropbox plan: the link does not expire until you stop sharing" // said, not silently none (QA's INFO 6)
	}
	writeJSON(w, http.StatusOK, res)
}

func (b *DropboxBackup) clock() time.Time {
	if b.now != nil {
		return b.now()
	}
	return time.Now()
}

func shareRefusal(code, msg string) map[string]any { return map[string]any{"code": code, "error": msg} }

// writeShareRefusal writes a share route's refusal. A 429 here is always a per-action limit (20 shares an hour, or Dropbox asking Coral to
// wait), so it goes out with httputil.WriteActionLimit (marked X-Coral-Limit: action, with Retry-After when known): the dashboard must not take
// it for an overloaded server and pause every poller (the limit census).
func writeShareRefusal(w http.ResponseWriter, code int, refusal map[string]any) {
	if code == http.StatusTooManyRequests {
		retry, _ := refusal["retry_after"].(int)
		c, _ := refusal["code"].(string)
		msg, _ := refusal["error"].(string)
		httputil.WriteActionLimit(w, retry, c, msg)
		return
	}
	writeJSON(w, code, refusal)
}

// share does the work once the request is checked: reserve the row and a free name, copy (or upload) and verify, then add the people or make the
// link. Any failure after the copy undoes it (people removed, links revoked, the copy deleted at its rev) before answering.
func (b *DropboxBackup) share(ctx context.Context, cl *dropbox.Client, access, account, kind, digest string, src shareSource, name, audience string,
	emails []string, expires time.Time) (map[string]any, int, map[string]any) {
	if err := cl.CanShare(ctx, access); err != nil { // an older sign-in, or an app without the sharing permissions, is told before anything is made
		var wait *dropbox.RateLimited
		switch {
		case errors.Is(err, dropbox.ErrMissingScope):
			return nil, http.StatusForbidden, shareRefusal("sign_in_again", signInAgainText)
		case errors.As(err, &wait):
			r := shareRefusal("dropbox_wait", fmt.Sprintf("Dropbox asked Coral to wait %s; nothing was shared. Try again then.", wait.After))
			r["retry_after"] = int(wait.After.Seconds())
			return nil, http.StatusTooManyRequests, r
		}
		// The client's errors carry Dropbox's tag only (never a body, token or link): said and logged, so a failure names its cause (#198059).
		slog.Warn("[dropbox] the sharing check failed", "error", err.Error())
		return nil, http.StatusBadGateway, shareRefusal("dropbox", "Dropbox refused the sharing check ("+err.Error()+"); nothing was shared")
	}
	folder := shareRoot + "/" + shareFolder(src.team)
	taken := map[string]bool{}
	names, err := cl.ListNames(ctx, access, folder)
	if err != nil && !errors.Is(err, dropbox.ErrNotFound) {
		return nil, http.StatusBadGateway, shareRefusal("dropbox", "Could not read the Shared from Coral folder; try again")
	}
	for _, n := range names {
		taken[strings.ToLower(n)] = true
	}
	sh := store.DropboxShare{Digest: digest, Kind: kind, Audience: audience, People: len(emails), AccountID: account, Hash: dropbox.ContentHash(src.data)}
	if !expires.IsZero() {
		sh.ExpiresAt = expires.Format(time.RFC3339)
	}
	var id int64
	for n := 1; n <= 50; n++ {
		cand := name
		if n > 1 {
			cand = withSuffix(name, n)
		}
		if taken[strings.ToLower(cand)] {
			continue
		}
		sh.Path = folder + "/" + cand
		id, err = b.outbox.ReserveShare(ctx, sh, b.clock())
		if errors.Is(err, store.ErrShareNameTaken) {
			continue
		}
		break
	}
	switch {
	case errors.Is(err, store.ErrShareLimit):
		return nil, http.StatusTooManyRequests, shareRefusal("limit", err.Error())
	case err != nil || id == 0:
		return nil, http.StatusConflict, shareRefusal("name_taken", "Every name like this one is taken in Shared from Coral; choose another name")
	}
	sh.ID = id

	meta, err := b.copyToShare(ctx, cl, access, account, digest, src.data, sh.Path)
	if err != nil {
		_ = b.outbox.ShareGone(ctx, id)
		if errors.Is(err, dropbox.ErrMissingScope) {
			return nil, http.StatusForbidden, shareRefusal("sign_in_again", signInAgainText)
		}
		return nil, http.StatusBadGateway, shareRefusal("copy", "Could not make the copy to share; nothing was shared")
	}
	if meta.ContentHash != dropbox.ContentHash(src.data) { // condition 5: the copy is these bytes, or it is deleted
		sh.FileID, sh.Rev = meta.FileID, meta.Rev
		_ = b.outbox.ShareCopied(ctx, id, meta.FileID, meta.Rev)
		_ = b.stopShare(ctx, cl, access, sh)
		return nil, http.StatusBadGateway, shareRefusal("copy_mismatch", "The copy in Dropbox is not this file; it was deleted and nothing was shared")
	}
	sh.FileID, sh.Rev = meta.FileID, meta.Rev
	if err := b.outbox.ShareCopied(ctx, id, meta.FileID, meta.Rev); err != nil {
		_ = b.stopShare(ctx, cl, access, sh)
		return nil, http.StatusInternalServerError, shareRefusal("", "could not record the share")
	}

	out := map[string]any{"id": id, "name": path.Base(sh.Path), "folder": folder, "audience": audience, "version": src.version}
	switch audience {
	case store.DropboxSharePeople:
		err = cl.AddFileMembers(ctx, access, meta.FileID, emails)
		out["people"] = len(emails)
	default:
		var l dropbox.Link
		l, err = cl.CreateLink(ctx, access, sh.Path, dropbox.Audience(audience), expires)
		if errors.Is(err, dropbox.ErrLinkExists) { // the new copy cannot have one; Dropbox says it has: read it rather than guess
			var links []dropbox.Link
			if links, err = cl.SharedLinks(ctx, access, sh.Path); err == nil && len(links) > 0 {
				l = links[0]
			} else if err == nil {
				err = dropbox.ErrBadLink
			}
		}
		if err == nil {
			out["link"] = l.URL
			if !l.Expires.IsZero() {
				out["expires_at"] = l.Expires.UTC().Format(time.RFC3339)
			}
		}
	}
	if err != nil {
		stopErr := b.stopShare(ctx, cl, access, sh)
		switch {
		case stopErr != nil:
			return nil, http.StatusBadGateway, shareRefusal("still_shared", "Sharing failed part way and Coral could not undo it yet: Settings lists it with Stop sharing")
		case errors.Is(err, dropbox.ErrMissingScope):
			return nil, http.StatusForbidden, shareRefusal("sign_in_again", signInAgainText)
		case errors.Is(err, dropbox.ErrLinkSettings):
			return nil, http.StatusConflict, shareRefusal("settings", "Your Dropbox plan does not allow this kind of link")
		}
		return nil, http.StatusBadGateway, shareRefusal("share", "Dropbox did not share it; nothing was shared")
	}
	exp, _ := out["expires_at"].(string)
	if err := b.outbox.ShareLive(ctx, id, exp); err != nil {
		_ = b.stopShare(ctx, cl, access, sh)
		return nil, http.StatusInternalServerError, shareRefusal("", "could not record the share; it was undone")
	}
	if audience == store.DropboxSharePeople {
		_ = b.outbox.RememberShareContacts(ctx, account, emails, b.clock()) // for the dialog's suggestions (#16170); a failure loses a suggestion, not the share
	}
	_ = b.d.store.AddAudit(ctx, store.DropboxAudit{Kind: store.DropboxAuditShare, Who: "operator", Reason: audience, Count: len(emails)})
	return out, http.StatusOK, nil
}

// copyToShare makes the copy at to: inside Dropbox from the backup's own file of these bytes when the ledger has one done at a rev with this
// content hash (nothing uploaded again), otherwise an upload of the verified bytes (mode add: never over a file there).
func (b *DropboxBackup) copyToShare(ctx context.Context, cl *dropbox.Client, access, account, digest string, data []byte, to string) (dropbox.Meta, error) {
	want := dropbox.ContentHash(data)
	if rows, err := b.outbox.LedgerOfDigest(ctx, account, digest); err == nil {
		for _, row := range rows {
			if row.Kind != store.DropboxKindVersion || row.State != store.DropboxOutboxDoneS || row.Rev == "" || row.ContentHash != want {
				continue
			}
			m, err := cl.Copy(ctx, access, row.Path, to)
			if err == nil || errors.Is(err, dropbox.ErrMissingScope) {
				return m, err
			}
			if !errors.Is(err, dropbox.ErrNotFound) {
				return dropbox.Meta{}, err
			}
			break // the backup's file is gone from Dropbox: upload instead
		}
	}
	sid, err := cl.StartSession(ctx, access, data)
	if err != nil {
		return dropbox.Meta{}, err
	}
	res, err := cl.FinishBatch(ctx, access, []dropbox.Commit{{SessionID: sid, Size: int64(len(data)), Path: to}})
	if err != nil {
		return dropbox.Meta{}, err
	}
	if len(res) != 1 || res[0].Outcome != dropbox.CommitOK {
		return dropbox.Meta{}, errors.New("the upload was refused")
	}
	return dropbox.Meta{FileID: res[0].FileID, Rev: res[0].Rev, ContentHash: res[0].ContentHash}, nil
}

// stopShare stops one share (condition 8): the row is marked stopping, the people are removed and every link of the copy is revoked (read again
// from Dropbox, so a link made before a crash is found too); only when all of that succeeded is the copy deleted at its rev and the row
// dropped. A copy changed in Dropbox since (another rev) is left there, the person's, with its people and links already gone.
func (b *DropboxBackup) stopShare(ctx context.Context, cl *dropbox.Client, access string, sh store.DropboxShare) error {
	if err := b.outbox.ShareStopping(ctx, sh.ID); err != nil {
		return err
	}
	if sh.FileID == "" { // reserved, never recorded as copied
		m, err := cl.Metadata(ctx, access, sh.Path)
		switch {
		case err == nil && sh.Hash != "" && m.ContentHash == sh.Hash:
			sh.FileID, sh.Rev = m.FileID, m.Rev // a crash between the copy and recording it: the file is this share's copy
		case err == nil || errors.Is(err, dropbox.ErrNotFound):
			// Nothing there, or a file that is not these bytes (the person put one at that name since): not Coral's, left alone.
			return b.outbox.ShareGone(ctx, sh.ID)
		default:
			return err
		}
	}
	// A sign-in without the sharing scopes cannot have shared it, and cannot read or revoke what an earlier one did: deleting the copy below
	// ends every link and membership of it all the same, so it goes ahead.
	if err := cl.UnshareFile(ctx, access, sh.FileID); err != nil && !errors.Is(err, dropbox.ErrMissingScope) {
		return err
	}
	links, err := cl.SharedLinks(ctx, access, sh.Path)
	if err != nil && !errors.Is(err, dropbox.ErrNotFound) && !errors.Is(err, dropbox.ErrMissingScope) {
		return err
	}
	for _, l := range links {
		if err := cl.RevokeLink(ctx, access, l.URL); err != nil {
			return err // the link is still live: the copy stays, the row stays stopping
		}
	}
	outs, done, err := b.runDelete(ctx, cl, access, []dropbox.Delete{{Path: sh.Path, Rev: sh.Rev}})
	if err != nil {
		return err
	}
	if !done || len(outs) != 1 {
		return errors.New("the copy's delete is still running")
	}
	if outs[0] == dropbox.DeleteRetry {
		return errors.New("Dropbox asked Coral to try the delete later")
	}
	return b.outbox.ShareGone(ctx, sh.ID) // DeleteOK, DeleteNotFound, or DeleteRefused (changed in Dropbox: left there, unshared)
}

// DropboxShares answers GET /api/dropbox/shares: every share, for Settings (condition 9), with live links read again.
func (h *CloudHandler) DropboxShares(w http.ResponseWriter, r *http.Request) {
	b, ok := h.shareGate(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	shares, err := b.outbox.Shares(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not read the shares")
		return
	}
	cl, access, account, aerr := b.dropboxAccess(ctx)
	if aerr != nil {
		cl = nil
	}
	list := []map[string]any{}
	for _, sh := range shares {
		list = append(list, b.shareView(ctx, cl, access, account, sh))
	}
	writeJSON(w, http.StatusOK, map[string]any{"connected": aerr == nil, "shares": list})
}

// DropboxStopShare answers POST /api/dropbox/share/stop/{id}: Stop sharing one copy.
func (h *CloudHandler) DropboxStopShare(w http.ResponseWriter, r *http.Request) {
	b, ok := h.shareGate(w, r)
	if !ok || !requireJSON(w, r) {
		return
	}
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id < 1 {
		errBadRequest(w, "not a share")
		return
	}
	ctx := r.Context()
	sh, err := b.outbox.Share(ctx, id)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "That share is already stopped")
		return
	}
	n, code, refusal := b.stopShares(ctx, []store.DropboxShare{sh})
	if refusal != nil {
		writeShareRefusal(w, code, refusal)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"stopped": n})
}

// DropboxStopAllShares answers POST /api/dropbox/shares/stop-all {confirm: true}: Stop sharing every copy.
func (h *CloudHandler) DropboxStopAllShares(w http.ResponseWriter, r *http.Request) {
	b, ok := h.shareGate(w, r)
	if !ok || !requireJSON(w, r) {
		return
	}
	var in struct {
		Confirm bool `json:"confirm"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
	if err := decodeJSONStrict(r, &in); err != nil || !in.Confirm {
		writeError(w, http.StatusBadRequest, "confirm_required", "Stop all needs your confirm")
		return
	}
	ctx := r.Context()
	shares, err := b.outbox.Shares(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not read the shares")
		return
	}
	n, code, refusal := b.stopShares(ctx, shares)
	if refusal != nil {
		refusal["stopped"] = n
		writeShareRefusal(w, code, refusal)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"stopped": n})
}

// stopShares stops each share in turn and audits how many stopped. A share of another Dropbox account is not this sign-in's to stop.
func (b *DropboxBackup) stopShares(ctx context.Context, shares []store.DropboxShare) (int, int, map[string]any) {
	if len(shares) == 0 {
		return 0, http.StatusOK, nil
	}
	cl, access, account, err := b.dropboxAccess(ctx)
	if err != nil {
		return 0, http.StatusConflict, shareRefusal("not_connected", "Connect Dropbox to stop sharing")
	}
	stopped, failed, other := 0, 0, 0
	for _, sh := range shares {
		if sh.AccountID != account {
			other++
			continue
		}
		if err := b.stopShare(ctx, cl, access, sh); err != nil {
			failed++
			continue
		}
		stopped++
	}
	if stopped > 0 {
		_ = b.d.store.AddAudit(ctx, store.DropboxAudit{Kind: store.DropboxAuditShare, Who: "operator", Reason: "stopped", Count: stopped})
	}
	switch {
	case failed > 0:
		return stopped, http.StatusBadGateway, shareRefusal("still_shared", fmt.Sprintf("%d still shared: Dropbox did not stop it yet, so its link may still work. Try again.", failed))
	case other > 0:
		return stopped, http.StatusConflict, shareRefusal("other_account", fmt.Sprintf("%d shared from another Dropbox account: sign in to that account to stop it, or stop it in Dropbox", other))
	}
	return stopped, http.StatusOK, nil
}

// CleanShares undoes the shares a crash or a failure left preparing or stopping (run with the backup's passes): their people and links are found
// again from Dropbox, revoked, and the copy deleted at its rev. Nothing stale: no Dropbox call.
func (b *DropboxBackup) CleanShares(ctx context.Context) {
	stale, err := b.outbox.StaleShares(ctx, b.clock().Add(-shareStaleAfter))
	if err != nil || len(stale) == 0 {
		return
	}
	cl, access, account, err := b.dropboxAccess(ctx)
	if err != nil {
		return
	}
	for _, sh := range stale {
		if sh.AccountID == account {
			_ = b.stopShare(ctx, cl, access, sh)
		}
	}
}

// sharesGuard is Disconnect's, Switch's and Rekey's check (Security's condition 9): while files are still shared through Dropbox it answers 409
// with how many, so the page offers Stop all first; leave (the Operator's confirm to leave them shared in their Dropbox, theirs to manage there)
// lets the action go on. It reports whether the caller may go on.
func (d *dropboxRoutes) sharesGuard(ctx context.Context, w http.ResponseWriter, leave bool, after string) bool {
	if d == nil || d.backup == nil || leave {
		return true
	}
	n, err := d.backup.outbox.SharedCount(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not read the files shared through Dropbox")
		return false
	}
	if n == 0 {
		return true
	}
	files := "files are"
	if n == 1 {
		files = "file is"
	}
	writeJSON(w, http.StatusConflict, map[string]any{"code": "still_shared", "count": n,
		"error": fmt.Sprintf("%d %s still shared through Dropbox. Stop sharing them first, or leave them shared: %s", n, files, after)})
	return false
}

// forgetShares drops the share rows after a Disconnect, Switch or Rekey that went ahead: their copies and links stay in the person's Dropbox.
func (d *dropboxRoutes) forgetShares(ctx context.Context) {
	if d != nil && d.backup != nil {
		d.backup.forgetContacts()
		if _, err := d.backup.outbox.ForgetShares(ctx); err != nil {
			slog.Warn("[dropbox] the list of shared files was not cleared")
		}
	}
}

const (
	shareSuggestMax      = 8
	shareSuggestFolders  = 20
	shareSuggestCacheTTL = 5 * time.Minute
	shareSuggestFailTTL  = 30 * time.Second
)

// DropboxShareContacts answers GET /api/dropbox/share-contacts?q=: up to eight addresses for the share dialog to suggest as the person types (#16170). Dropbox has no call that lists
// a person's contacts, so they come from (a) the addresses this Coral already shared to (kept here, per account) and (b) the people in the shared folders this Dropbox account has
// (read live under the sharing.read scope Coral already holds, cached five minutes in memory, never stored). Only the person at this computer's dashboard gets any (shareGate:
// nothing over the Hub path), and an address already shared to comes first.
func (h *CloudHandler) DropboxShareContacts(w http.ResponseWriter, r *http.Request) {
	b, ok := h.shareGate(w, r)
	if !ok {
		return
	}
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	if len(q) > 100 {
		q = q[:100]
	}
	ctx := r.Context()
	cl, access, account, err := b.dropboxAccess(ctx)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"emails": []string{}})
		return
	}
	out := []string{}
	seen := map[string]bool{}
	if mine, err := b.outbox.ShareContacts(ctx, account, q, shareSuggestMax); err == nil {
		for _, e := range mine {
			seen[e] = true
			out = append(out, e)
		}
	}
	if len(out) < shareSuggestMax {
		for _, e := range b.folderContacts(ctx, cl, access, account) {
			if len(out) >= shareSuggestMax {
				break
			}
			if !seen[e] && strings.Contains(e, q) {
				seen[e] = true
				out = append(out, e)
			}
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"emails": out})
}

// folderContacts is the people in the account's shared folders (cached five minutes per account); a Dropbox that cannot be read gives none, and that failure is kept 30 seconds
// too, so a Dropbox that is down or rate-limited is asked once, not on every keystroke (Security's SHOULD on #16170). The lock covers the cache fields only, never the network calls:
// a second caller while a read is under way gets what is kept (or none) instead of waiting for it or starting another.
func (b *DropboxBackup) folderContacts(ctx context.Context, cl *dropbox.Client, access, account string) []string {
	b.contactsMu.Lock()
	ttl := shareSuggestCacheTTL
	if b.contactsFailed {
		ttl = shareSuggestFailTTL
	}
	if b.contactsFor == account && b.clock().Sub(b.contactsAt) < ttl {
		list := b.contactsList
		b.contactsMu.Unlock()
		return list
	}
	if b.contactsBusy {
		b.contactsMu.Unlock()
		return nil
	}
	b.contactsBusy = true
	gen := b.contactsGen
	b.contactsMu.Unlock()

	list, err := cl.FolderMemberEmails(ctx, access, shareSuggestFolders)

	b.contactsMu.Lock()
	defer b.contactsMu.Unlock()
	b.contactsBusy = false
	if gen != b.contactsGen {
		return list // the account went while this read was under way: nothing of it is kept
	}
	b.contactsFor, b.contactsAt, b.contactsFailed = account, b.clock(), err != nil
	if err != nil {
		b.contactsList = nil
		return nil
	}
	b.contactsList = list
	return list
}

// forgetContacts empties the folder-member cache: the people of the old account's folders go with a Disconnect, Switch or Rekey, as the remembered addresses do.
func (b *DropboxBackup) forgetContacts() {
	b.contactsMu.Lock()
	b.contactsFor, b.contactsAt, b.contactsList, b.contactsFailed = "", time.Time{}, nil, false
	b.contactsGen++
	b.contactsMu.Unlock()
}
