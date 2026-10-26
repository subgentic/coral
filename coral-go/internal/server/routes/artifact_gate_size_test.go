package routes

import (
	"encoding/binary"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #8387: imageSizeOK (the received-file gate) applies the same limits as checkPixels (auto-attach) with its own error texts; each limit is pinned on both sides before the two share one rule.
func TestImageSizeOKPinsEachLimitOnBothSides(t *testing.T) {
	for _, tc := range []struct {
		name string
		w, h int
		want string // "" is accepted
	}{
		{"width at the side limit", attachMaxSide, 1, ""},
		{"width over the side limit", attachMaxSide + 1, 1, "too many pixels"},
		{"height at the side limit", 1, attachMaxSide, ""},
		{"height over the side limit", 1, attachMaxSide + 1, "too many pixels"},
		{"within both sides, over the area", 10000, 10000, "too many pixels"},
		{"exactly attachMaxPixels", 8000, attachMaxPixels / 8000, ""},
		{"one row over attachMaxPixels", 8000, attachMaxPixels/8000 + 1, "too many pixels"},
		{"a tall image at attachMaxPixels", attachMaxPixels / 4000, 4000, ""},
		{"a tall image one column over", attachMaxPixels/4000 + 1, 4000, "too many pixels"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := imageSizeOK(pngHeader(tc.w, tc.h), "image/png")
			if tc.want == "" {
				assert.NoError(t, err)
			} else {
				assert.EqualError(t, err, tc.want)
			}
		})
	}
}

func TestImageSizeOKReadsEachFamilyAndRefusesTheUnreadable(t *testing.T) {
	assert.NoError(t, imageSizeOK(pngBytes(t, 40, 30), "image/png"))
	assert.EqualError(t, imageSizeOK([]byte("\x89PNG not really"), "image/png"), "bad image")
	assert.EqualError(t, imageSizeOK([]byte("\xff\xd8\xff\xe0 junk"), "image/jpeg"), "bad image")
	assert.EqualError(t, imageSizeOK([]byte("GIF89a"), "image/gif"), "bad image")
	assert.EqualError(t, imageSizeOK([]byte("RIFF\x00\x00\x00\x00WEBPJUNKJUNKJUNKJUNKJUNKJUNKJUNK"), "image/webp"), "bad image")

	vp8 := func(w, h uint16) []byte {
		payload := make([]byte, 10)
		payload[3], payload[4], payload[5] = 0x9d, 0x01, 0x2a
		binary.LittleEndian.PutUint16(payload[6:8], w)
		binary.LittleEndian.PutUint16(payload[8:10], h)
		return webpHeader("VP8 ", payload)
	}
	assert.NoError(t, imageSizeOK(vp8(1, 1), "image/webp"))
	assert.EqualError(t, imageSizeOK(vp8(0, 5), "image/webp"), "too many pixels", "no width")
	assert.EqualError(t, imageSizeOK(vp8(5, 0), "image/webp"), "too many pixels", "no height")
	huge := webpHeader("VP8X", make([]byte, 20))
	binary.LittleEndian.PutUint16(huge[24:26], 0xffff)
	assert.EqualError(t, imageSizeOK(huge, "image/webp"), "too many pixels")

	// A format whose size is not read here (TIFF, HEIF) is not measured: its bytes are not looked at.
	assert.NoError(t, imageSizeOK([]byte("not even an image"), "image/tiff"))
	assert.NoError(t, imageSizeOK(nil, "image/heic"))
}
