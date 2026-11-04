package routes

import (
	"fmt"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/store"
	"testing"
)

func TestVideoCommentTimes(t *testing.T) {
	rig := newCmtRig(t)
	rig.artifact(cmtPic, "demo.mp4", "video/mp4")
	for _, at := range []float64{0, 12.25} {
		code, out := rig.do("POST", cp(cmtPic), cmtAsOwner, map[string]any{"body": "cut here", "at_s": at, "end_s": 20.5})
		require.Equal(t, 201, code, out)
		require.Equal(t, at, out["at_s"])
		require.Equal(t, 20.5, out["end_s"])
	}
	for _, body := range []map[string]any{
		{"body": "bad", "at_s": -1}, {"body": "bad", "end_s": 2},
		{"body": "bad", "at_s": 2, "end_s": 2}, {"body": "bad", "at_s": 2, "end_s": 1},
		{"body": "bad", "at_s": 604801}, {"body": "bad", "at_s": 0, "end_s": 604801},
		{"body": "bad", "at_s": 1, "anchor": map[string]any{"whole": false, "quote": "x", "start_line": 1, "end_line": 1}},
	} {
		code, out := rig.do("POST", cp(cmtPic), cmtAsOwner, body)
		require.Equal(t, 400, code, out)
	}
	code, out := rig.do("POST", cp(cmtDoc), cmtAsOwner, map[string]any{"body": "bad", "at_s": 1})
	require.Equal(t, 400, code, out)
}

func TestVideoCommentsReadAndCarryTimes(t *testing.T) {
	rig := newCmtRig(t)
	rig.artifact(cmtDoc, "demo.mp4", "video/mp4")
	rig.artifact(cmtPic2, "demo.mp4", "video/mp4")
	rig.twoVersions("old video", "new video")
	for _, at := range []float64{40.5, 0, 12.25} {
		code, out := rig.do("POST", cp(cmtDoc), cmtAsOwner, map[string]any{"body": "cut here", "at_s": at, "board": "team-a"})
		require.Equal(t, 201, code, out)
	}
	code, out := rig.do("GET", cp(cmtDoc), cmtAsOwner, nil)
	require.Equal(t, 200, code, out)
	list := out["comments"].([]any)
	for i, at := range []float64{0, 12.25, 40.5} {
		require.Equal(t, at, list[i].(map[string]any)["at_s"])
	}
	carried := rig.carriedOn()
	require.Len(t, carried, 3)
	for i, at := range []float64{0, 12.25, 40.5} {
		require.Equal(t, at, carried[i]["at_s"])
		require.Equal(t, "found", carried[i]["carried"])
		require.Equal(t, cmtDoc, carried[i]["artifact_id"])
	}
}

func TestVideoCommentResolveAndReopenKeepTimes(t *testing.T) {
	rig := newCmtRig(t)
	rig.artifact(cmtPic, "demo.webm", "video/webm")
	code, out := rig.do("POST", cp(cmtPic), cmtAsOwner, map[string]any{"body": "cut", "at_s": 12.5, "end_s": 18.5})
	require.Equal(t, 201, code, out)
	cid := int64(out["id"].(float64))
	for _, action := range []string{"resolve", "reopen"} {
		code, out = rig.do("POST", fmt.Sprintf("%s/%d/%s", cp(cmtPic), cid, action), cmtAsOwner, nil)
		require.Equal(t, 200, code, out)
		require.Equal(t, 12.5, out["at_s"])
		require.Equal(t, 18.5, out["end_s"])
	}
}

func TestVideoCommentLabel(t *testing.T) {
	at, end := 65.9, 125.25
	require.Equal(t, "Video time: 01:05–02:05", videoCommentLabel(store.ArtifactComment{AtS: &at, EndS: &end}))
	require.Empty(t, videoCommentLabel(store.ArtifactComment{}))
}

func TestVideoCommentDeliveryIncludesTimeAndReplyThread(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.uploadedBy(1, "team-a")
	rig.artifact(cmtDoc, "demo.mp4", "video/mp4")
	code, out := rig.do("POST", cp(cmtDoc), cmtAsOwner, map[string]any{"body": "speed up", "at_s": 65.25, "end_s": 70.0, "board": "team-a"})
	require.Equal(t, 201, code, out)
	msgs := rig.operatorMessages()
	require.Len(t, msgs, 1)
	require.Contains(t, msgs[0].Content, "Video time: 01:05–01:10")
	require.Contains(t, msgs[0].Content, fmt.Sprintf("%s %d", cmtDoc, int64(out["id"].(float64))))
	require.Contains(t, msgs[0].Content, "untrusted")
}
