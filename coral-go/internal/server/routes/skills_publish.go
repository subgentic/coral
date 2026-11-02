package routes

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/subgentic/coral/internal/httputil"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/safefs"
	"github.com/subgentic/coral/internal/secrets"
	"github.com/subgentic/coral/internal/skills"
	"github.com/subgentic/coral/internal/store"
)

// Publishing to the Skills Store (#12024, goal #191). An agent's skill waits for the Operator; the Operator's own is approved at once. Both arrive as JSON with the zip in base64 (the command line's
// one way of sending a body), are parsed with every archive rule of the skills package, and are kept in the Skills Store's own folder.

// publishesPerHour is how many skills one agent session may publish in an hour.
const publishesPerHour = 5

// maxPublishBody is the largest request body: the zip's cap in base64, with room for the JSON around it.
const maxPublishBody = (skills.MaxZipBytes*4)/3 + 4096

type publishRequest struct {
	Zip          string `json:"zip_base64"`
	ScriptsAcked bool   `json:"scripts_acked"`
	// AcknowledgeSecret is the Operator's one confirmation that a file of their own skill holds what looks like a key or token and goes in anyway (logged).
	AcknowledgeSecret bool `json:"acknowledge_secret"`
}

// allowPublish is the hourly limit on publishing, per agent session.
func (h *SkillsHandler) allowPublish(session string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.published == nil {
		h.published = map[string][]time.Time{}
	}
	now := h.nowFunc()
	for k, ts := range h.published { // a session that stopped publishing leaves nothing behind
		if len(ts) == 0 || now.Sub(ts[len(ts)-1]) >= time.Hour {
			delete(h.published, k)
		}
	}
	keep := h.published[session][:0]
	for _, t := range h.published[session] {
		if now.Sub(t) < time.Hour {
			keep = append(keep, t)
		}
	}
	if len(keep) >= publishesPerHour {
		h.published[session] = keep
		return false
	}
	h.published[session] = append(keep, now)
	return true
}

// readPublished reads the zip from the request: JSON with zip_base64, at most maxPublishBody bytes.
func readPublished(w http.ResponseWriter, r *http.Request) (data []byte, req publishRequest, ok bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxPublishBody)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "skill_too_large", "a skill is a zip of at most 5 MiB")
		return nil, req, false
	}
	if json.Unmarshal(raw, &req) != nil || req.Zip == "" {
		errBadRequest(w, `send {"zip_base64": "<the zip>"}`)
		return nil, req, false
	}
	data, err = base64.StdEncoding.DecodeString(req.Zip)
	if err != nil || len(data) == 0 {
		errBadRequest(w, "zip_base64 must be the zip, in base64")
		return nil, req, false
	}
	if len(data) > skills.MaxZipBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "skill_too_large", "a skill is a zip of at most 5 MiB")
		return nil, req, false
	}
	return data, req, true
}

// skillsRoot opens the data folder and makes the Skills Store's folders (0700), refusing a link in the place of either.
func (h *SkillsHandler) skillsRoot() (*safefs.Root, error) {
	root, err := safefs.OpenRoot(h.cfg.CoralDir())
	if err != nil {
		return nil, err
	}
	for _, rel := range []string{"skills", "skills/objects"} {
		if err := root.MkdirAll(rel, 0o700); err != nil {
			root.Close()
			return nil, err
		}
		fi, err := root.Lstat(rel)
		if err != nil || !fi.IsDir() || fi.Mode()&os.ModeSymlink != 0 {
			root.Close()
			return nil, errors.New("the skills folder is not a plain folder")
		}
	}
	return root, nil
}

// saveSkillZip keeps the zip under its digest, 0600, created new and never replaced: bytes already there must be the same bytes, or the store is damaged and nothing is written. created says whether this call
// made the file. A reader checks the digest on every read, so a write cut short is never served.
func (h *SkillsHandler) saveSkillZip(digest string, data []byte) (created bool, err error) {
	h.zipMu.Lock() // two publishes of the same new bytes at once: the second reads a finished file, not a half-written one
	defer h.zipMu.Unlock()
	root, err := h.skillsRoot()
	if err != nil {
		return false, err
	}
	defer root.Close()
	rel := "skills/objects/" + digest
	if _, err := root.Lstat(rel); err == nil {
		have, rerr := root.ReadFile(rel, skills.MaxZipBytes)
		sum := sha256.Sum256(have)
		if rerr != nil || hex.EncodeToString(sum[:]) != digest {
			return false, errors.New("the stored copy of this skill is damaged")
		}
		return false, nil
	}
	f, err := root.CreateNew(rel, 0o600)
	if err != nil {
		return false, err
	}
	_, werr := f.Write(data)
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		_ = root.Remove(rel)
		return false, werr
	}
	return true, nil
}

func (h *SkillsHandler) dropSkillZip(digest string) {
	h.zipMu.Lock()
	defer h.zipMu.Unlock()
	if root, err := h.skillsRoot(); err == nil {
		defer root.Close()
		_ = root.Remove("skills/objects/" + digest)
	}
}

// releaseSkillZip deletes the bytes of a skill the Operator rejected or removed, unless another record still points at the same digest: the digest stays in skills_refused, which is all the refusal needs, and the
// bytes (possibly a secret) do not stay for ever.
func (h *SkillsHandler) releaseSkillZip(r *http.Request, digest string) {
	if inUse, err := h.ss.SkillDigestInUse(r.Context(), digest); err == nil && !inUse {
		h.dropSkillZip(digest)
	}
}

// heldSecret names the first file of an agent's skill that holds what the redactor finds (a key, a token, a password): the same redaction as session excerpts. A redactor that cannot check refuses the publish.
func heldSecret(sk *skills.Skill) (file string, err error) {
	red := secrets.Redactor()
	paths := make([]string, 0, len(sk.Content))
	for p := range sk.Content {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		out, rerr := red.Text(sk.Content[p])
		if rerr != nil {
			return "", rerr
		}
		if !bytes.Equal(out, sk.Content[p]) {
			return p, nil
		}
	}
	return "", nil
}

// fileWithSignInLink names the first file of a skill whose text holds a sign-in link (the same test the board's posts use), "" when none does.
func fileWithSignInLink(sk *skills.Skill) string {
	paths := make([]string, 0, len(sk.Content))
	for p := range sk.Content {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		if hasSignInLink(string(sk.Content[p])) {
			return p
		}
	}
	return ""
}

// publish parses, keeps and records one skill; false when the answer was written.
func (h *SkillsHandler) publish(w http.ResponseWriter, r *http.Request, data []byte, in store.AddSkillInput, acknowledgeSecret bool) (row *store.SkillRow, secretAcked string, ok bool) {
	sk, err := skills.Parse(data)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_skill", strings.TrimPrefix(err.Error(), skills.ErrInvalid.Error()+": "))
		return nil, "", false
	}
	// The names of Coral's own example skills are Coral's (#12463): an agent's skill under one would sit beside the example and read as it.
	if in.Kind == store.PublisherAgent && skills.IsStarterName(sk.Name) {
		writeError(w, http.StatusConflict, "reserved_name", "that name belongs to an example skill that ships with Coral: publish under another name")
		return nil, "", false
	}
	// A skill's text is stored, shown and read by agents: a file that carries a sign-in link (login_token=) is refused whoever publishes it, naming the file, before a byte is kept (the sign-in link census).
	if f := fileWithSignInLink(sk); f != "" {
		writeError(w, http.StatusBadRequest, "sign_in_link", "a file holds a sign-in link: remove it from "+skillFileName(f)+" and publish again")
		return nil, "", false
	}
	// Everything is checked for secrets before a byte is kept; the reply names the file, never the secret. An agent's skill with one is refused. The Operator's own is warned once: the same publish with
	// acknowledge_secret goes in and the acknowledgement is logged, so a key is never approved into every agent without being told.
	secretFile, rerr := heldSecret(sk)
	if rerr != nil {
		writeError(w, http.StatusServiceUnavailable, "cannot_check", "the skill could not be checked for secrets: try again")
		return nil, "", false
	}
	if secretFile != "" {
		if in.Kind == store.PublisherAgent {
			writeError(w, http.StatusUnprocessableEntity, "holds_secret", "a file holds what looks like a key, token or password: remove it from "+skillFileName(secretFile)+" and publish again")
			return nil, "", false
		}
		if !acknowledgeSecret {
			writeError(w, http.StatusConflict, "holds_secret", skillFileName(secretFile)+" holds what looks like a key, token or password, and every agent that has this skill would read it.")
			return nil, "", false
		}
	}
	in.Skill, in.Digest = sk, sk.Digest
	created, err := h.saveSkillZip(sk.Digest, data)
	if err != nil {
		errInternalServer(w, "could not keep the skill")
		return nil, "", false
	}
	added, _, err := h.ss.AddSkill(r.Context(), in)
	if err != nil {
		if created { // nothing refers to the bytes this call wrote
			h.dropSkillZip(sk.Digest)
		}
		switch {
		case errors.Is(err, store.ErrAgentScripts):
			writeError(w, http.StatusUnprocessableEntity, "agent_files", "an agent's skill may hold only SKILL.md and document or data files (.md .txt .json .yaml .yml .csv .toml)")
		case errors.Is(err, store.ErrNeedScriptsAck):
			writeError(w, http.StatusConflict, "scripts_not_acknowledged", "this skill has scripts or files that cannot be shown as text: review them and confirm")
		case errors.Is(err, store.ErrPendingCap):
			writeError(w, http.StatusConflict, "too_many_pending", "too many skills are waiting for the Operator: wait for a decision")
		case errors.Is(err, store.ErrSkillRefusedBefore):
			writeError(w, http.StatusConflict, "refused_before", "the Operator already rejected or removed this skill")
		case errors.Is(err, store.ErrTooManySkills):
			writeError(w, http.StatusConflict, "too_many_skills", "the Skills Store is full")
		default:
			errInternalServer(w, "could not record the skill")
		}
		return nil, "", false
	}
	if secretFile != "" { // the Operator's acknowledgement, in the log with the file's name and no part of the secret
		_ = h.ss.LogSkillAccess(r.Context(), "secret_acknowledged", added.ID, added.Digest, store.PublisherOperator, "operator", secretFile)
		secretAcked = secretFile
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": added.ID, "name": added.Name, "version": added.Version, "status": added.Status, "digest": added.Digest})
	return added, secretAcked, true
}

// PublishSkillAgent: POST /api/agent/skills {"zip_base64": ...}. Only an agent with its session token. The skill waits for the Operator: it is not searchable, not attachable and not served to anyone until
// approved. Who published it is the session's agent and team, never anything in the skill. At most five an hour per session.
func (h *SkillsHandler) PublishSkillAgent(w http.ResponseWriter, r *http.Request) {
	sid, ok := callerSession(w, r, "", false, nil)
	if !ok {
		return
	}
	if _, isAgent := VerifiedSession(r.Context()); !isAgent {
		errForbidden(w, "an agent publishes with its own session token")
		return
	}
	if !h.allowPublish(sid) {
		httputil.WriteActionLimit(w, 0, "rate_limited", "at most 5 skills an hour") // a per-action limit, marked so the dashboard does not take it for an overloaded server
		return
	}
	data, _, ok := readPublished(w, r)
	if !ok {
		return
	}
	agentName, team := sid, ""
	if names, err := h.ss.GetAgentNames(r.Context(), []string{sid}); err == nil {
		if n, found := names[sid]; found && n[0] != "" {
			agentName = n[0]
		}
	}
	if ls, err := h.ss.GetLiveSession(r.Context(), sid); err == nil && ls != nil && ls.BoardName != nil {
		team = *ls.BoardName
	}
	h.publish(w, r, data, store.AddSkillInput{Kind: store.PublisherAgent, Agent: agentName, Team: team}, false) // the log row of the publish is written with the record; an agent's publish is not the Operator's action
}

// PublishSkillOperator: POST /api/skills {"zip_base64": ..., "scripts_acked": ...}. Only a person at the dashboard. The Operator's own skill is approved at once; one with scripts or files that cannot be shown
// as text needs scripts_acked (the second click), the only way scripts get into the store in v1.
func (h *SkillsHandler) PublishSkillOperator(w http.ResponseWriter, r *http.Request) {
	if !humanInputCaller(r) {
		writeError(w, http.StatusForbidden, "operator_only", "only a person at the dashboard publishes a skill")
		return
	}
	data, req, ok := readPublished(w, r)
	if !ok {
		return
	}
	row, secret, ok := h.publish(w, r, data, store.AddSkillInput{Kind: store.PublisherOperator, ScriptsAcked: req.ScriptsAcked}, req.AcknowledgeSecret)
	if !ok {
		return
	}
	h.record(r, board.ActSkillImport, row, "")
	h.recordAcks(r, row, req.ScriptsAcked, secret)
}

// skillFileName is a file's path as one clean word for a reply (the parser already refused control and invisible characters in it).
func skillFileName(p string) string { return "'" + strings.ReplaceAll(p, "'", "") + "'" }
