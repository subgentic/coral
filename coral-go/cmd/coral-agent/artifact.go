package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/hooks"
	"github.com/subgentic/coral/internal/mediatype"
)

const artifactUsageText = `Usage: coral-agent artifact upload <file> [--name NAME] [--media-type TYPE] [--new-version-of <link>] [--task N | --no-task] [--tag WORD]...
       coral-agent artifact download <coral://artifacts/digest> [--output FILE] [--force]
       coral-agent artifact reply <coral://artifacts/digest> <comment-id> <text | ->
Run coral-agent artifact upload --help, artifact download --help or artifact reply --help for one of them.`

const artifactUploadUsageText = `Usage: coral-agent artifact upload <file> [--name NAME] [--media-type TYPE] [--new-version-of <link>] [--task N | --no-task] [--tag WORD]...

An upload is linked to the task you have in progress (the reply says task_id, and this prints
"Linked to task #N"); the task's page and the team's Artifacts tab then list it. --task N links it to
another task of yours instead; --no-task links it to none. A task that is not yours is refused and
nothing is stored.

--new-version-of adds the file as a new version of an artifact this agent's board uploaded (its
coral://artifacts/<digest> link, or a series link coral://artifacts/series/<id>): the reply carries
series_id, version and versions. Same bytes as the newest version add nothing (exit 0); same
bytes as an older version are refused (non-zero), so nobody takes it for the newest.

--tag puts a word on the file in your team's Artifacts tab (repeat it, at most 5 in all; lowercase letters, digits, spaces and
hyphens, 24 characters at most): tag a file "for review" when a person must look at it before the task can close, and logs and
scratch files "internal"; do not invent other tags unless the task asks for one. A word that is not a tag is left out.

Upload long reports, logs, diffs and evidence instead of pasting them into posts.
Link the returned coral://artifacts/<digest> in a short board post: a one-line
summary, then numbered points, one per line; answer numbered posts by number.
Use @Name; put SHAs, branches and paths in backticks. To post a longer text from
Windows use coral-board post --file <path> (coral-board help windows); in Bash,
coral-board post - <<'EOF' (body and closing EOF on separate lines).
Never put backticks or $( ) inside a double-quoted post argument.`

const artifactReplyUsageText = `Usage: coral-agent artifact reply <coral://artifacts/digest> <comment-id> <text | ->

reply answers a comment the Operator sent you (the message names this exact command with the
link and the comment id filled in): it posts your text into that comment's thread, as you, and
only into a thread you were asked into. Give the text as one argument, or - to read it from
standard input (for several lines or quotes). At most 5 replies of 8 KiB each per thread; a
reply is checked for secrets before it is kept. A refusal (not asked, the thread ended, too many
replies, the board paused or asleep) prints Coral's reason and exits non-zero. The options may
stand before or after the link.`

const artifactDownloadUsageText = `Usage: coral-agent artifact download <coral://artifacts/digest> [--output FILE] [--force]

Downloads the artifact, checks its SHA-256 and prints the local path. The options
may stand before or after the link; --force replaces an existing --output file.`

// artifactUsage is the usage of one artifact operation, or of all of them when rest names none.
func artifactUsage(rest []string) string {
	if len(rest) > 0 {
		switch rest[0] {
		case "upload":
			return artifactUploadUsageText
		case "download":
			return artifactDownloadUsageText
		case "reply":
			return artifactReplyUsageText
		}
	}
	return artifactUsageText
}

func cmdArtifact(args []string) {
	if len(args) >= 1 && args[0] == "reply" {
		cmdArtifactReply(args[1:])
		return
	}
	if len(args) >= 1 && args[0] == "download" {
		opts, err := splitOptions(args[1:], []string{"output"}, []string{"force"})
		if err != nil || len(opts.Positional) != 1 {
			if err == nil {
				err = fmt.Errorf("download needs exactly one artifact link")
			}
			fmt.Fprintf(os.Stderr, "Error: %v\n%s\n", err, artifactDownloadUsageText)
			os.Exit(2)
		}
		path, err := downloadArtifactOpts(serverURL, opts.Positional[0], opts.Values["output"], opts.Bools["force"])
		var ue usageError
		if errors.As(err, &ue) {
			failUsage(ue.msg, "artifact", args)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			clierr.Exit1()
		}
		fmt.Println(path)
		return
	}
	if len(args) < 2 || args[0] != "upload" {
		fmt.Fprintln(os.Stderr, artifactUsageText)
		clierr.Exit1()
	}
	opts, err := splitOptions(args[1:], []string{"name", "media-type", "new-version-of", "task", "tag"}, []string{"no-task"})
	if err != nil || len(opts.Positional) != 1 {
		if err == nil {
			err = fmt.Errorf("upload needs exactly one file")
		}
		fmt.Fprintf(os.Stderr, "Error: %v\n%s\n", err, artifactUploadUsageText)
		os.Exit(2)
	}
	file := opts.Positional[0]
	task := opts.Values["task"]
	if opts.Bools["no-task"] {
		if task != "" {
			fmt.Fprintf(os.Stderr, "Error: give --task N or --no-task, not both\n%s\n", artifactUploadUsageText)
			os.Exit(2)
		}
		task = "none"
	}
	if task != "" && task != "none" {
		if n, perr := strconv.ParseInt(task, 10, 64); perr != nil || n <= 0 {
			fmt.Fprintf(os.Stderr, "Error: --task needs a task number\n%s\n", artifactUploadUsageText)
			os.Exit(2)
		}
	}
	name, ok := opts.Values["name"]
	if !ok {
		name = filepath.Base(file)
	}
	name = mediatype.EnsureExtension(name, file)
	mediaType := mediatype.Resolve(opts.Values["media-type"], file, name)
	if err := uploadArtifactTags(serverURL, file, name, mediaType, resolveSessionID(), opts.Values["new-version-of"], task, opts.All["tag"], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
}

// uploadArtifact streams file to Coral's artifact store and, on success, prints the coral:// reply
// to stdout. A refused or failed upload (any non-2xx; the Retry-After is surfaced on a 429) returns
// an error and prints NO link, so a caller that misses the exit code can't take a refusal for a
// success (#4004: the CLI used to exit 0 on a refused upload, so dead links were posted).
func uploadArtifact(serverURL, file, name, mediaType, sid, newVersionOf, task string, stdout, stderr io.Writer) error {
	return uploadArtifactTags(serverURL, file, name, mediaType, sid, newVersionOf, task, nil, stdout, stderr)
}

// uploadArtifactTags is uploadArtifact with the tags asked for the file (#8583), each sent as a tag parameter.
func uploadArtifactTags(serverURL, file, name, mediaType, sid, newVersionOf, task string, tags []string, stdout, stderr io.Writer) error {
	f, err := os.Open(file) // streamed to Coral, not read into memory (#3553)
	if err != nil {
		return err
	}
	defer f.Close()
	req, err := http.NewRequest(http.MethodPost, serverURL+"/api/agent/artifacts?session_id="+url.QueryEscape(sid)+tagQuery(tags), f)
	if err != nil {
		return err
	}
	req.Header.Set("X-Artifact-Name", name)
	if newVersionOf != "" { // exactly a 64-hex artifact link or a 32-hex series link: the server refuses anything else before any lookup (#6357)
		req.Header.Set("X-Artifact-New-Version-Of", newVersionOf)
	}
	if mediaType != "" {
		req.Header.Set("X-Artifact-Media-Type", mediaType)
	}
	if task != "" { // a task number, or "none": the server checks it is the agent's own (#7739)
		req.Header.Set("X-Artifact-Task", task)
	}
	wait := clierr.Timeout(5 * time.Minute) // http.DefaultClient has no timeout: an upload to a server that stopped answering waited for ever
	resp, err := (&http.Client{Timeout: wait}).Do(req)
	if err != nil {
		return clierr.CannotReach(hooks.RedactedURL(serverURL), err, wait)
	}
	defer resp.Body.Close()
	clierr.NoteStatus(resp.StatusCode)
	body, _ := clitext.ReadReply(resp.Body, rawOutput)
	var reply struct {
		URI      string `json:"uri"`
		TaskID   int64  `json:"task_id"`
		Error    string `json:"error"`
		Code     string `json:"code"`
		Stripped bool   `json:"stripped"`
	}
	_ = json.Unmarshal(body, &reply)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		reason := reply.Error // Coral's own words (#3553): too large, an hourly or store limit, image metadata.
		if reason == "" {
			reason = strings.TrimSpace(string(body))
		}
		if reason == "" {
			reason = resp.Status
		}
		if resp.StatusCode == http.StatusTooManyRequests {
			if ra := strings.TrimSpace(resp.Header.Get("Retry-After")); ra != "" {
				return fmt.Errorf("artifact upload refused (rate limited): %s (Retry-After: %s)", reason, ra)
			}
			return fmt.Errorf("artifact upload refused (rate limited): %s", reason)
		}
		return fmt.Errorf("artifact upload failed. Coral says: %s (HTTP %d)", reason, resp.StatusCode)
	}
	// A 2xx with no coral:// id is not a stored artifact: never print it as a link (#4004 (b):
	// defends against a success-shaped refusal, so the exit code is the only thing that can be wrong).
	if reply.URI == "" {
		reason := strings.TrimSpace(string(body))
		if reason == "" {
			reason = resp.Status
		}
		return fmt.Errorf("artifact upload returned no artifact id. Coral says: %s (HTTP %d)", reason, resp.StatusCode)
	}
	if reply.Stripped {
		fmt.Fprintln(stderr, "Note: Coral removed this image's metadata (camera, location) before storing it, so its id is the SHA-256 of the stored bytes, not of your file.")
	}
	fmt.Fprintln(stdout, string(body))
	if reply.TaskID > 0 { // the reply (stdout) is the JSON a script reads; the line for a person is on stderr (#7739)
		fmt.Fprintf(stderr, "Linked to task #%d\n", reply.TaskID)
	}
	return nil
}

// cmdArtifactReply is "coral-agent artifact reply <link> <comment-id> <text | ->" (#6523): the reply to a comment the Operator sent this agent (the Send-to-agent message names this
// command with the ids filled in). The text is one argument, or - for standard input.
func cmdArtifactReply(args []string) {
	if len(args) != 3 {
		fmt.Fprintf(os.Stderr, "Error: reply needs the artifact link, the comment id and the text (or - for standard input)\n%s\n", artifactUsageText)
		os.Exit(2)
	}
	text := args[2]
	if text == "-" {
		b, err := io.ReadAll(io.LimitReader(os.Stdin, 64<<10))
		if err != nil {
			fmt.Fprintln(os.Stderr, "Error: could not read the reply from standard input:", err)
			clierr.Exit1()
		}
		text = string(b)
	}
	if err := replyToComment(serverURL, args[0], args[1], text, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
}

// replyToComment posts text into the thread of comment commentID of the artifact ref, through the reply route (the agent's own token says who it is; the server decides whether it was
// asked). It prints one line on success; a refusal is an error carrying Coral's own reason.
func replyToComment(serverURL, ref, commentID, text string, stdout io.Writer) error {
	id, err := artifactDigest(serverURL, ref)
	if err != nil {
		return err
	}
	n, err := strconv.ParseInt(commentID, 10, 64)
	if err != nil || n <= 0 {
		return fmt.Errorf("the comment id is the number in the message you were sent, not %q", commentID)
	}
	commentID = strconv.FormatInt(n, 10) // the path is exactly the digits: "+5" and "0005" are 5
	if strings.TrimSpace(text) == "" {
		return fmt.Errorf("a reply needs some text")
	}
	payload, _ := json.Marshal(map[string]string{"body": text})
	req, err := http.NewRequest(http.MethodPost, serverURL+"/api/artifacts/"+id+"/comments/"+commentID+"/reply", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	wait := clierr.Timeout(time.Minute)
	resp, err := (&http.Client{Timeout: wait}).Do(req)
	if err != nil {
		return clierr.CannotReach(hooks.RedactedURL(serverURL), err, wait)
	}
	defer resp.Body.Close()
	clierr.NoteStatus(resp.StatusCode)
	body, _ := clitext.ReadReply(resp.Body, rawOutput)
	var reply struct {
		ID    int64  `json:"id"`
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	_ = json.Unmarshal(body, &reply)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		reason := reply.Error
		if reason == "" {
			reason = strings.TrimSpace(string(body))
		}
		if reason == "" {
			reason = resp.Status
		}
		if reply.Code != "" {
			reason += " (" + reply.Code + ")"
		}
		return fmt.Errorf("reply refused (HTTP %d): %s", resp.StatusCode, reason)
	}
	if reply.ID == 0 { // a 2xx that is not a stored comment is not a reply
		return fmt.Errorf("the reply was not kept (HTTP %d): %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	fmt.Fprintf(stdout, "Reply posted (comment %d).\n", reply.ID)
	return nil
}

// tagQuery is the tag parameters of an upload: "&tag=<word>" for each.
func tagQuery(tags []string) string {
	var b strings.Builder
	for _, t := range tags {
		b.WriteString("&tag=" + url.QueryEscape(t))
	}
	return b.String()
}
