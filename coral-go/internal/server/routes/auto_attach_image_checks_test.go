package routes

import (
	"encoding/binary"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #8314: the image checks of auto-attach that no test called directly (sniffImage, checkPixels, webpSize), pinned before the image code moves into its own file.

func webpHeader(chunk string, payload []byte) []byte {
	d := []byte("RIFF\x00\x00\x00\x00WEBP" + chunk + "\x00\x00\x00\x00")
	return append(d, payload...)
}

func TestSniffImageByMagicBytes(t *testing.T) {
	assert.Equal(t, "image/png", sniffImage(pngBytes(t, 2, 2)))
	assert.Equal(t, "image/jpeg", sniffImage([]byte("\xff\xd8\xff\xe0\x00\x10JFIF\x00")))
	assert.Equal(t, "image/gif", sniffImage([]byte("GIF89a\x01\x00\x01\x00\x00\x00\x00")))
	assert.Equal(t, "image/webp", sniffImage(webpHeader("VP8X", make([]byte, 20))))
	assert.Empty(t, sniffImage([]byte("plain text, not an image")), "text is not an image")
	assert.Empty(t, sniffImage([]byte("%PDF-1.7 ...")), "a type outside the four is refused")
	assert.Empty(t, sniffImage([]byte("<svg xmlns='http://www.w3.org/2000/svg'></svg>")), "svg is not one of ours")
	assert.Empty(t, sniffImage(nil))
}

func TestWebpSizeReadsEachChunkKind(t *testing.T) {
	// VP8X: canvas width-1 and height-1 as 24-bit little endian after 4 flag bytes
	vp8x := make([]byte, 10)
	vp8x[4], vp8x[5], vp8x[6] = 0x7f, 0x02, 0x00 // 639
	vp8x[7], vp8x[8], vp8x[9] = 0xdf, 0x01, 0x00 // 479
	w, h, ok := webpSize(append(webpHeader("VP8X", vp8x), make([]byte, 10)...))
	assert.True(t, ok)
	assert.Equal(t, 640, w)
	assert.Equal(t, 480, h)

	// VP8 (lossy): a key frame signature 9d 01 2a, then 14-bit width and height
	vp8 := make([]byte, 10)
	vp8[3], vp8[4], vp8[5] = 0x9d, 0x01, 0x2a
	binary.LittleEndian.PutUint16(vp8[6:8], 0xc000|321) // the top two bits are a scale, not size
	binary.LittleEndian.PutUint16(vp8[8:10], 123)
	w, h, ok = webpSize(append(webpHeader("VP8 ", vp8), make([]byte, 10)...))
	assert.True(t, ok)
	assert.Equal(t, 321, w)
	assert.Equal(t, 123, h)
	vp8[3] = 0
	_, _, ok = webpSize(append(webpHeader("VP8 ", vp8), make([]byte, 10)...))
	assert.False(t, ok, "no key frame signature")

	// VP8L (lossless): signature 0x2f, then 14-bit width-1 and height-1
	vp8l := make([]byte, 10)
	vp8l[0] = 0x2f
	binary.LittleEndian.PutUint32(vp8l[1:5], uint32(99)|uint32(49)<<14)
	w, h, ok = webpSize(append(webpHeader("VP8L", vp8l), make([]byte, 10)...))
	assert.True(t, ok)
	assert.Equal(t, 100, w)
	assert.Equal(t, 50, h)
	vp8l[0] = 0
	_, _, ok = webpSize(append(webpHeader("VP8L", vp8l), make([]byte, 10)...))
	assert.False(t, ok, "no lossless signature")

	_, _, ok = webpSize(append(webpHeader("XXXX", vp8x), make([]byte, 10)...))
	assert.False(t, ok, "an unknown first chunk")
	_, _, ok = webpSize([]byte("RIFF\x00\x00\x00\x00WEBPVP8X"))
	assert.False(t, ok, "too short")
	bad := webpHeader("VP8X", vp8x)
	copy(bad[8:12], "WAVE")
	_, _, ok = webpSize(append(bad, make([]byte, 10)...))
	assert.False(t, ok, "not a WebP container")
}

func TestCheckPixelsRefusesWhatIsTooBigOrUnreadable(t *testing.T) {
	assert.NoError(t, checkPixels(pngBytes(t, 40, 30), "image/png"))
	assert.EqualError(t, checkPixels([]byte("\x89PNG not really"), "image/png"), "bad_image")
	assert.EqualError(t, checkPixels(pngBytes(t, attachMaxSide+1, 1), "image/png"), "too_many_pixels", "a side over the limit")
	assert.NoError(t, checkPixels(pngBytes(t, attachMaxSide, 1), "image/png"), "exactly the side limit")

	vp8x := make([]byte, 20)
	huge := webpHeader("VP8X", vp8x)
	binary.LittleEndian.PutUint16(huge[24:26], 0xffff) // canvas width-1 far over the side limit
	assert.EqualError(t, checkPixels(huge, "image/webp"), "too_many_pixels")
	assert.NoError(t, checkPixels(webpHeader("VP8X", vp8x), "image/webp"), "a 1 x 1 canvas")
	assert.EqualError(t, checkPixels([]byte("RIFF\x00\x00\x00\x00WEBPJUNKJUNKJUNKJUNKJUNKJUNKJUNK"), "image/webp"), "bad_image")
}
