package routes

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #11650 (goal #184, slice 1): a person's comment can carry pictures. The route is the person's alone, decides the type by the file's own bytes, stores each picture on the commented file's team,
// and the comment names only pictures just uploaded for it; a comment with pictures may have no words; an agent reads them by link.

func shadePNG(t *testing.T, shade uint8) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	for x := 0; x < 4; x++ {
		img.Set(x, 0, color.RGBA{shade, 20, 30, 255})
	}
	var b bytes.Buffer
	require.NoError(t, png.Encode(&b, img))
	return b.Bytes()
}

func plainJPEG(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	require.NoError(t, jpeg.Encode(&b, image.NewRGBA(image.Rect(0, 0, 4, 4)), nil))
	return b.Bytes()
}

// imageRig is a comment rig with a document its team's agent uploaded (so a picture has a team to be kept with).
type imageRig struct {
	*cmtRig
	doc, session string
}

func newImageRig(t *testing.T) *imageRig {
	t.Helper()
	rig := newCmtRig(t)
	old := uploaderLookup
	t.Cleanup(func() { uploaderLookup = old })
	uploaderLookup = func(ctx context.Context, sid string) (string, string, string) { return "team-a", "Dev", "Developer" }
	rig.agent(1, "Dev", false)
	coralDir := rig.h.cfg.CoralDir()
	data := []byte("# the plan\n")
	sum := sha256.Sum256(data)
	id := hex.EncodeToString(sum[:])
	tmp := filepath.Join(coralDir, "artifacts", "objects", artifactUploadTempP+"doc")
	require.NoError(t, os.MkdirAll(filepath.Dir(tmp), 0o700))
	require.NoError(t, os.WriteFile(tmp, data, 0o600))
	_, _, err := storeArtifactFileAs(coralDir, sendSid(1), "plan.md", "text/markdown", tmp, id, int64(len(data)), nil, 0, nil)
	require.NoError(t, err)
	return &imageRig{cmtRig: rig, doc: id, session: sendSid(1)}
}

func (rig *imageRig) upload(header map[string]string, contentType, query string, body []byte) (int, map[string]any) {
	rig.t.Helper()
	req, err := http.NewRequest("POST", rig.srv.URL+"/api/artifacts/"+rig.doc+"/comment-images"+query, bytes.NewReader(body))
	require.NoError(rig.t, err)
	req.Header.Set("Content-Type", contentType)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(rig.t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func (rig *imageRig) comment(header map[string]string, body any) (int, map[string]any) {
	return rig.do("POST", cp(rig.doc), header, body)
}

func TestACommentCarriesPicturesTheServerChecksByTheirBytes(t *testing.T) {
	rig := newImageRig(t)
	pngBytes := shadePNG(t, 200)

	// The person uploads a picture: stored on the commented file's team (the upload record of the session of that team), as a comment picture.
	code, out := rig.upload(cmtAsOwner, "image/png", "", pngBytes)
	require.Equal(t, http.StatusCreated, code, "%v", out)
	h1 := out["hex"].(string)
	assert.Equal(t, "image/png", out["content_type"])
	assert.Equal(t, "picture.png", out["name"])
	rec, ok := readUploadRecord(rig.h.cfg.CoralDir(), rig.session, h1)
	require.True(t, ok, "the picture is an artifact of the team's session")
	assert.Equal(t, sourceCommentImage, rec.Source)

	// The type is the bytes', never the declared one; a mismatch and what is not a picture are refused with nothing stored.
	for _, tc := range []struct {
		name, ct, code string
		body           []byte
	}{
		{"png sent as jpeg", "image/jpeg", "image_type_mismatch", pngBytes},
		{"jpeg sent as png", "image/png", "image_type_mismatch", plainJPEG(t)},
		{"text sent as png", "image/png", "image_type", []byte("not a picture at all")},
		{"a gif is not taken", "image/gif", "image_type", []byte("GIF89a....")},
		{"declared text", "text/plain", "image_type", pngBytes},
	} {
		code, out := rig.upload(cmtAsOwner, tc.ct, "", tc.body)
		assert.Equal(t, http.StatusUnsupportedMediaType, code, tc.name)
		assert.Equal(t, tc.code, out["code"], tc.name)
	}
	code, out = rig.upload(cmtAsOwner, "image/png", "", bytes.Repeat([]byte{0x89}, maxCommentImageBytes+10))
	assert.Equal(t, http.StatusRequestEntityTooLarge, code, "%v", out)
	assert.Equal(t, "image_too_large", out["code"])

	// The person's alone: an agent, a Hub guest and a forged stamp are refused.
	for name, hdr := range map[string]map[string]string{"agent": cmtAsAgent, "hub guest": cmtAsHub, "forged": cmtAsForged} {
		code, _ := rig.upload(hdr, "image/png", "", shadePNG(t, 7))
		assert.GreaterOrEqual(t, code, 400, name)
		assert.Less(t, code, 500, name)
	}

	// A comment with only a picture is a comment; the list and the answer carry it, in the order sent; an agent reads it by link.
	code, out = rig.upload(cmtAsOwner, "image/jpeg", "", plainJPEG(t))
	require.Equal(t, http.StatusCreated, code, "%v", out)
	h2 := out["hex"].(string)
	code, out = rig.comment(cmtAsOwner, map[string]any{"body": "", "images": []string{h1, h2}, "anchor": map[string]any{"whole": true}, "board": "team-a"})
	require.Equal(t, http.StatusCreated, code, "a picture alone is a comment: %v", out)
	imgs := out["images"].([]any)
	require.Len(t, imgs, 2)
	assert.Equal(t, h1, imgs[0].(map[string]any)["hex"])
	assert.Equal(t, h2, imgs[1].(map[string]any)["hex"])
	cid := int64(out["id"].(float64))
	code, list := rig.do("GET", cp(rig.doc)+"?board=team-a", cmtAsOwner, nil)
	require.Equal(t, http.StatusOK, code, "%v", list)
	assert.Contains(t, fmt.Sprint(list["comments"]), h1, "the list carries the pictures")
	code, res := rig.do("POST", fmt.Sprintf("%s/%d/send", cp(rig.doc), cid), cmtAsOwner, map[string]any{"agents": []string{"Dev"}})
	require.Equal(t, http.StatusOK, code, "%v", res)
	var sent string
	for _, m := range rig.operatorMessages() {
		sent += m.Content
	}
	assert.Contains(t, sent, "coral://artifacts/"+h1)
	assert.Contains(t, sent, "coral://artifacts/"+h2)

	// Words are still needed when there is no picture; a picture that was not uploaded for this comment, a fifth one and a repeat are refused.
	code, _ = rig.comment(cmtAsOwner, map[string]any{"body": "", "anchor": map[string]any{"whole": true}})
	assert.Equal(t, http.StatusBadRequest, code)
	code, _ = rig.comment(cmtAsOwner, map[string]any{"body": "x", "images": []string{strings.Repeat("ab", 32)}, "anchor": map[string]any{"whole": true}})
	assert.Equal(t, http.StatusBadRequest, code, "a hex nobody uploaded for this comment")
	code, _ = rig.comment(cmtAsOwner, map[string]any{"body": "x", "images": []string{rig.doc}, "anchor": map[string]any{"whole": true}})
	assert.Equal(t, http.StatusBadRequest, code, "a stored artifact that was not uploaded as this comment's picture")
	code, _ = rig.comment(cmtAsOwner, map[string]any{"body": "x", "images": []string{h1, h1}, "anchor": map[string]any{"whole": true}})
	assert.Equal(t, http.StatusBadRequest, code, "a repeat")
	var five []string
	for i := 0; i < 5; i++ {
		five = append(five, h1)
	}
	code, _ = rig.comment(cmtAsOwner, map[string]any{"body": "x", "images": five, "anchor": map[string]any{"whole": true}})
	assert.Equal(t, http.StatusBadRequest, code, "at most four")

	// Only the person attaches pictures: an agent's comment naming one is refused.
	code, _ = rig.comment(cmtAsAgent, map[string]any{"body": "x", "images": []string{h1}, "anchor": map[string]any{"whole": true}})
	assert.GreaterOrEqual(t, code, 400)

	// Deleting the comment erases its pictures from it (the files stay artifacts of the team).
	code, _ = rig.do("DELETE", fmt.Sprintf("%s/%d", cp(rig.doc), cid), cmtAsOwner, nil)
	require.Equal(t, http.StatusOK, code)
	got, found, err := rig.ss.GetArtifactComment(context.Background(), rig.doc, cid)
	require.NoError(t, err)
	require.True(t, found)
	assert.Empty(t, got.ImagesJSON)
	_ = board.OperatorName
}

func TestAMarkedUpPictureIsTheNextVersionOfThePicture(t *testing.T) {
	rig := newImageRig(t)
	code, out := rig.upload(cmtAsOwner, "image/png", "", shadePNG(t, 90))
	require.Equal(t, http.StatusCreated, code, "%v", out)
	v1 := out["hex"].(string)
	code, out = rig.upload(cmtAsOwner, "image/png", "?version_of="+v1, shadePNG(t, 91))
	require.Equal(t, http.StatusCreated, code, "%v", out)
	assert.EqualValues(t, 2, out["version"])
	assert.NotEmpty(t, out["series_id"])
	assert.NotEqual(t, v1, out["hex"])
	// QA's SHOULD: the newest version's bytes again add nothing: 200 "same", that version, the same series.
	series := out["series_id"]
	code, same := rig.upload(cmtAsOwner, "image/png", "?version_of="+v1, shadePNG(t, 91))
	require.Equal(t, http.StatusOK, code, "%v", same)
	assert.Equal(t, true, same["same"])
	assert.EqualValues(t, 2, same["version"])
	assert.Equal(t, series, same["series_id"])
	// Only a picture just added for this file can be marked up.
	code, _ = rig.upload(cmtAsOwner, "image/png", "?version_of="+strings.Repeat("cd", 32), shadePNG(t, 92))
	assert.Equal(t, http.StatusNotFound, code)
	code, _ = rig.upload(cmtAsOwner, "image/png", "?version_of="+rig.doc, shadePNG(t, 93))
	assert.Equal(t, http.StatusNotFound, code, "a stored file that is not a picture just added is no series to extend")
}

// Five different pictures are refused (QA's SHOULD on #11650), four are taken: the limit is on the count, not only on a repeat.
func TestAFifthPictureOnACommentIsRefused(t *testing.T) {
	rig := newImageRig(t)
	var hexes []string
	for i := 0; i < 5; i++ {
		code, out := rig.upload(cmtAsOwner, "image/png", "", shadePNG(t, uint8(40+i)))
		require.Equal(t, http.StatusCreated, code, "%v", out)
		hexes = append(hexes, out["hex"].(string))
	}
	require.Len(t, map[string]bool{hexes[0]: true, hexes[1]: true, hexes[2]: true, hexes[3]: true, hexes[4]: true}, 5, "five different pictures")
	code, out := rig.comment(cmtAsOwner, map[string]any{"body": "five", "images": hexes, "anchor": map[string]any{"whole": true}})
	assert.Equal(t, http.StatusBadRequest, code, "%v", out)
	assert.Contains(t, fmt.Sprint(out["error"]), "at most 4")
	code, out = rig.comment(cmtAsOwner, map[string]any{"body": "four", "images": hexes[:4], "anchor": map[string]any{"whole": true}})
	assert.Equal(t, http.StatusCreated, code, "four are taken: %v", out)
	assert.Len(t, out["images"], 4)
}

// #12176: a marked-up picture is kept whatever the file belongs to. A file of an agent that is on no team cannot have a series of versions (a version belongs to a team), so the marked picture is stored on its own as the
// person's picture, with the file's agent, instead of being refused and the comment going out with the plain one.
func TestAMarkedUpPictureOnAFileOfAnAgentWithNoTeamIsKeptOnItsOwn(t *testing.T) {
	rig := newImageRig(t)
	uploaderLookup = func(ctx context.Context, sid string) (string, string, string) { return "", "Dev", "Developer" } // the agent is on no board
	code, out := rig.upload(cmtAsOwner, "image/png", "", shadePNG(t, 90))
	require.Equal(t, http.StatusCreated, code, "%v", out)
	v1 := out["hex"].(string)
	code, out = rig.upload(cmtAsOwner, "image/png", "?version_of="+v1, shadePNG(t, 91))
	require.Equal(t, http.StatusCreated, code, "the marked picture is kept: %v", out)
	marked := out["hex"].(string)
	assert.NotEqual(t, v1, marked)
	assert.Nil(t, out["series_id"], "no team, so no series of versions")
	rec, ok := readUploadRecord(rig.h.cfg.CoralDir(), rig.session, marked)
	require.True(t, ok, "kept with the file's agent")
	assert.Equal(t, sourceCommentImage, rec.Source)
	assert.Equal(t, "owner", rec.UploadedBy)
	// and the comment names it, so the picture the person marked is the one that is sent
	code, c := rig.comment(cmtAsOwner, map[string]any{"body": "see the marks", "anchor": anchorOf("the lock"), "board": "team-a", "images": []string{marked}})
	require.Equal(t, http.StatusCreated, code, "%v", c)
	imgs, _ := c["images"].([]any)
	require.Len(t, imgs, 1)
	assert.Equal(t, marked, imgs[0].(map[string]any)["hex"])
}
