package routes

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func thumbnailFixture(t *testing.T, format string, w, h int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	img.Set(0, 0, color.NRGBA{R: 255, A: 255})
	var b bytes.Buffer
	var err error
	switch format {
	case "png":
		err = png.Encode(&b, img)
	case "jpeg":
		err = jpeg.Encode(&b, img, nil)
	case "gif":
		err = gif.Encode(&b, img, nil)
	}
	require.NoError(t, err)
	return b.Bytes()
}

func TestThumbnailCodecAndBounds(t *testing.T) {
	for _, format := range []string{"png", "jpeg", "gif"} {
		t.Run(format, func(t *testing.T) {
			for _, size := range [][2]int{{256, 128}, {12, 24}} {
				data, err := makeThumbnail(bytes.NewReader(thumbnailFixture(t, format, size[0], size[1])))
				require.NoError(t, err)
				c, err := png.DecodeConfig(bytes.NewReader(data))
				require.NoError(t, err)
				if size[0] > 128 {
					require.Equal(t, 128, c.Width)
					require.Equal(t, 64, c.Height)
				} else {
					require.Equal(t, 12, c.Width)
					require.Equal(t, 24, c.Height)
				}
			}
		})
	}
	for _, raw := range [][]byte{[]byte("<svg xmlns='http://www.w3.org/2000/svg'/>"), []byte("RIFFwebp"), []byte("GIF89a"), bytes.Repeat([]byte{1}, thumbnailInputLimit+1), thumbnailFixture(t, "png", thumbnailSideLimit+1, 1), thumbnailFixture(t, "png", 2001, 2000)} {
		_, err := makeThumbnail(bytes.NewReader(raw))
		require.Error(t, err)
	}
}

type thumbnailPanicReader struct{}

func (thumbnailPanicReader) Read([]byte) (int, error) { panic("bad reader") }
func TestThumbnailDecodeRecovers(t *testing.T) {
	_, err := makeThumbnail(thumbnailPanicReader{})
	require.Error(t, err)
}

func TestThumbnailRouteRechecksCachedSource(t *testing.T) {
	rig := uploadRig(t)
	code, up := rig.upload("s1", "picture.png", "image/png", bytes.NewReader(thumbnailFixture(t, "png", 256, 128)))
	require.Equal(t, http.StatusCreated, code)
	id := strings.TrimPrefix(up["uri"].(string), "coral://artifacts/")
	read := func(tunneled bool) (int, http.Header, []byte) {
		req, err := http.NewRequest("GET", rig.srv.URL+"/api/artifacts/"+id+"/thumbnail", nil)
		require.NoError(t, err)
		req.Header.Set(testDashboardHeader, "1")
		if tunneled {
			setHubOwner(t, req)
		}
		r, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer r.Body.Close()
		b, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		return r.StatusCode, r.Header, b
	}
	for _, tunneled := range []bool{false, true} {
		status, h, data := read(tunneled)
		require.Equal(t, 200, status, string(data))
		require.Equal(t, "image/png", h.Get("Content-Type"))
		require.Equal(t, "private, no-store", h.Get("Cache-Control"))
		require.Equal(t, "nosniff", h.Get("X-Content-Type-Options"))
		require.Equal(t, "default-src 'none'", h.Get("Content-Security-Policy"))
		_, err := png.Decode(bytes.NewReader(data))
		require.NoError(t, err)
	}

	for _, caller := range hubCallers() {
		withLabel(t, caller.label, nil)
		status, body := hubGet(t, rig.srv.URL+"/api/artifacts/"+id+"/thumbnail", caller.header)
		if caller.allow {
			require.Equal(t, 200, status, caller.name+body)
		} else {
			require.Equal(t, 403, status, caller.name+body)
		}
	}
	statusAgent, _ := hubGet(t, rig.srv.URL+"/api/artifacts/"+id+"/thumbnail", map[string]string{testAgentHeader: "s1"})
	require.Equal(t, 403, statusAgent, "agents cannot read cached thumbnails")
	statusUnknown, _ := hubGet(t, rig.srv.URL+"/api/artifacts/"+id+"/thumbnail", nil)
	require.Equal(t, 200, statusUnknown, "local auth opt-out retains the existing content route policy")
	require.NoError(t, os.Remove(filepath.Join(rig.coralDir, "artifacts", "objects", id)))
	status, _, _ := read(false)
	require.Equal(t, 404, status, "cached pixels must not bypass deletion")
}

func TestThumbnailCacheBoundsAndFailedExpiry(t *testing.T) {
	key := t.TempDir() + "/failed"
	cacheThumbnail(key, nil)
	data, hit := cachedThumbnail(key)
	require.True(t, hit)
	require.Nil(t, data)
	thumbnails.Lock()
	e := thumbnails.rows[key]
	v := e.Value.(thumbnailEntry)
	v.failedUntil = time.Now().Add(-time.Second)
	e.Value = v
	thumbnails.Unlock()
	_, hit = cachedThumbnail(key)
	require.False(t, hit, "a decode failure can be retried after expiry")
	for i := 0; i < 300; i++ {
		cacheThumbnail(key+string(rune(i)), make([]byte, 128<<10))
	}
	thumbnails.Lock()
	defer thumbnails.Unlock()
	require.LessOrEqual(t, thumbnails.order.Len(), 256)
	require.LessOrEqual(t, thumbnails.bytes, thumbnailCacheLimit)
}
func TestThumbnailCapacityFailsFast(t *testing.T) {
	rig := uploadRig(t)
	code, up := rig.upload("s1", "unique.png", "image/png", bytes.NewReader(thumbnailFixture(t, "png", 17, 13)))
	require.Equal(t, 201, code)
	id := strings.TrimPrefix(up["uri"].(string), "coral://artifacts/")
	thumbnailSlots <- struct{}{}
	thumbnailSlots <- struct{}{}
	defer func() { <-thumbnailSlots; <-thumbnailSlots }()
	code, body := hubGet(t, rig.srv.URL+"/api/artifacts/"+id+"/thumbnail", map[string]string{testDashboardHeader: "1"})
	require.Equal(t, 503, code, body)
}

// GIF canvas dimensions can exceed its first frame. Keep that logical canvas
// without allocating or decoding the remaining animation frames.
func TestThumbnailGIFPartialFirstFrame(t *testing.T) {
	for _, transparent := range []bool{false, true} {
		t.Run(fmt.Sprint(transparent), func(t *testing.T) {
			palette := color.Palette{color.Black, color.White}
			if transparent {
				palette[0] = color.NRGBA{}
			}
			frame := image.NewPaletted(image.Rect(10, 12, 30, 32), palette)
			frame.SetColorIndex(15, 15, 1)
			var raw bytes.Buffer
			require.NoError(t, gif.EncodeAll(&raw, &gif.GIF{Image: []*image.Paletted{frame}, Delay: []int{0}, BackgroundIndex: 1, Config: image.Config{ColorModel: palette, Width: 80, Height: 60}}))
			data, err := makeThumbnail(bytes.NewReader(raw.Bytes()))
			require.NoError(t, err)
			img, err := png.Decode(bytes.NewReader(data))
			require.NoError(t, err)
			require.Equal(t, image.Rect(0, 0, 80, 60), img.Bounds())
			outside := color.NRGBAModel.Convert(img.At(0, 0)).(color.NRGBA)
			if transparent {
				require.Zero(t, outside.A)
			} else {
				require.Equal(t, color.NRGBA{255, 255, 255, 255}, outside, "opaque GIFs retain the declared global background colour")
			}
			_, _, _, inside := img.At(15, 15).RGBA()
			require.Equal(t, uint32(65535), inside)
		})
	}
}

func TestThumbnailIgnoresRegisteredDecoders(t *testing.T) {
	called := false
	image.RegisterFormat("thumbnail-unsupported-fixture", "THMB-CORAL",
		func(io.Reader) (image.Image, error) { called = true; return image.NewRGBA(image.Rect(0, 0, 1, 1)), nil },
		func(io.Reader) (image.Config, error) {
			called = true
			return image.Config{ColorModel: color.RGBAModel, Width: 1, Height: 1}, nil
		})
	_, err := makeThumbnail(strings.NewReader("THMB-CORAL"))
	require.Error(t, err)
	require.False(t, called, "registered formats cannot extend the derivative codec allowlist")
}

func TestThumbnailTransparentEdgesKeepColour(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 256, 1))
	for x := 0; x < 256; x += 2 {
		img.SetNRGBA(x, 0, color.NRGBA{R: 255, A: 255})
	}
	var raw bytes.Buffer
	require.NoError(t, png.Encode(&raw, img))
	data, err := makeThumbnail(bytes.NewReader(raw.Bytes()))
	require.NoError(t, err)
	decoded, err := png.Decode(bytes.NewReader(data))
	require.NoError(t, err)
	pixel := color.NRGBAModel.Convert(decoded.At(0, 0)).(color.NRGBA)
	require.GreaterOrEqual(t, int(pixel.R), 250, "transparent edges retain their red rather than gaining a dark halo")
	require.InDelta(t, 128, int(pixel.A), 1)
}
