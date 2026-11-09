package routes

import (
	"bytes"
	"container/list"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
)

const thumbnailInputLimit = 8 << 20
const thumbnailPixelLimit = 3_000_000
const thumbnailSideLimit = 4096
const thumbnailCacheLimit = 16 << 20

var errThumbnail = errors.New("thumbnail unavailable")
var thumbnailSlots = make(chan struct{}, 2)
var thumbnails = struct {
	sync.Mutex
	rows  map[string]*list.Element
	order *list.List
	bytes int
}{rows: make(map[string]*list.Element), order: list.New()}

type thumbnailEntry struct {
	key         string
	png         []byte
	failedUntil time.Time
}

func cachedThumbnail(key string) ([]byte, bool) {
	thumbnails.Lock()
	defer thumbnails.Unlock()
	e := thumbnails.rows[key]
	if e == nil {
		return nil, false
	}
	entry := e.Value.(thumbnailEntry)
	if !entry.failedUntil.IsZero() && !time.Now().Before(entry.failedUntil) {
		thumbnails.order.Remove(e)
		delete(thumbnails.rows, key)
		return nil, false
	}
	thumbnails.order.MoveToFront(e)
	return entry.png, true
}

func cacheThumbnail(key string, data []byte) {
	thumbnails.Lock()
	defer thumbnails.Unlock()
	if old := thumbnails.rows[key]; old != nil {
		thumbnails.bytes -= len(old.Value.(thumbnailEntry).png)
		thumbnails.order.Remove(old)
	}
	entry := thumbnailEntry{key: key, png: data}
	if data == nil {
		entry.failedUntil = time.Now().Add(time.Minute)
	}
	thumbnails.rows[key] = thumbnails.order.PushFront(entry)
	thumbnails.bytes += len(data)
	for thumbnails.order.Len() > 256 || thumbnails.bytes > thumbnailCacheLimit {
		e := thumbnails.order.Back()
		v := e.Value.(thumbnailEntry)
		thumbnails.bytes -= len(v.png)
		delete(thumbnails.rows, v.key)
		thumbnails.order.Remove(e)
	}
}

// Each caller is authenticated and the source is opened before consulting either
// positive or failed derivatives. No permission failure enters the digest cache.
func (h *SessionsHandler) artifactThumbnail(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if _, agent := agentSessionOf(r); agent {
		errForbidden(w, "thumbnail reads are not available to agents")
		return
	}
	if refuseNonOwner(w, r) {
		return
	}
	id := chi.URLParam(r, "id")
	if !validArtifactID(id) {
		errBadRequest(w, "invalid artifact id")
		return
	}
	if len(r.URL.Query()) != 0 {
		errBadRequest(w, "thumbnail parameters are not supported")
		return
	}
	f, _, info, ok := h.openArtifactForRead(w, r, id, false) // a thumbnail is a bulk read: never a fetch (stage 6b)
	if !ok {
		return
	}
	defer f.Close()
	if info.Size() > thumbnailInputLimit {
		errNotFound(w, "thumbnail unavailable")
		return
	}
	key := h.cfg.CoralDir() + "/thumbnail-v1/" + id
	data, hit := cachedThumbnail(key)
	if !hit {
		select {
		case thumbnailSlots <- struct{}{}:
			defer func() { <-thumbnailSlots }()
		default:
			w.Header().Set("Retry-After", "1")
			writeError(w, http.StatusServiceUnavailable, "thumbnail_busy", "thumbnail unavailable")
			return
		}
		data, hit = cachedThumbnail(key)
		if !hit {
			var err error
			data, err = makeThumbnail(io.LimitReader(f, thumbnailInputLimit+1))
			if err != nil {
				data = nil
			}
			cacheThumbnail(key, data)
		}
	}
	if data == nil {
		errNotFound(w, "thumbnail unavailable")
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Del("X-Coral-Build")
	w.Header().Set("Content-Length", fmt.Sprint(len(data)))
	_, _ = w.Write(data)
}

// Decode only these three codecs, regardless of decoders registered elsewhere.
// The bounded byte copy also prevents a file growing after Stat from exceeding
// the input limit. Config and decode both read that same bounded copy.
func makeThumbnail(r io.Reader) (out []byte, err error) {
	defer func() {
		if recover() != nil {
			out = nil
			err = errThumbnail
		}
	}()
	raw, err := io.ReadAll(io.LimitReader(r, thumbnailInputLimit+1))
	if err != nil || len(raw) > thumbnailInputLimit {
		return nil, errThumbnail
	}
	var config func(io.Reader) (image.Config, error)
	var decode func(io.Reader) (image.Image, error)
	switch {
	case bytes.HasPrefix(raw, []byte("\x89PNG\r\n\x1a\n")):
		config, decode = png.DecodeConfig, png.Decode
	case len(raw) >= 3 && raw[0] == 0xff && raw[1] == 0xd8 && raw[2] == 0xff:
		config, decode = jpeg.DecodeConfig, jpeg.Decode
	case bytes.HasPrefix(raw, []byte("GIF87a")) || bytes.HasPrefix(raw, []byte("GIF89a")):
		config, decode = gif.DecodeConfig, gif.Decode
	default:
		return nil, errThumbnail
	}
	c, err := config(bytes.NewReader(raw))
	if err != nil || c.Width <= 0 || c.Height <= 0 || c.Width > thumbnailSideLimit || c.Height > thumbnailSideLimit || c.Width > thumbnailPixelLimit/c.Height {
		return nil, errThumbnail
	}
	img, err := decode(bytes.NewReader(raw))
	if err != nil {
		return nil, errThumbnail
	}
	b := img.Bounds()
	if b.Empty() || b.Min.X < 0 || b.Min.Y < 0 || b.Max.X > c.Width || b.Max.Y > c.Height {
		return nil, errThumbnail
	}
	width, height := c.Width, c.Height
	if width > 128 || height > 128 {
		if width >= height {
			height = max(1, height*128/width)
			width = 128
		} else {
			width = max(1, width*128/height)
			height = 128
		}
	}
	target := image.NewRGBA(image.Rect(0, 0, width, height))
	// A first GIF frame can be offset within its logical canvas. Paletted.At
	// otherwise returns palette[0] outside the image. Use the GIF background for
	// an opaque frame; keep alpha padding when the first frame is transparent.
	var padding color.Color = color.RGBA{}
	if len(raw) >= 13 && (bytes.HasPrefix(raw, []byte("GIF87a")) || bytes.HasPrefix(raw, []byte("GIF89a"))) {
		transparent := false
		if first, ok := img.(*image.Paletted); ok {
			for _, entry := range first.Palette {
				_, _, _, alpha := entry.RGBA()
				if alpha == 0 {
					transparent = true
					break
				}
			}
		}
		if palette, ok := c.ColorModel.(color.Palette); ok && !transparent && int(raw[11]) < len(palette) {
			padding = palette[int(raw[11])]
		}
	}
	pixelAt := func(x, y int) color.Color {
		if !image.Pt(x, y).In(b) {
			return padding
		}
		return img.At(x, y)
	}

	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			// Interpolate premultiplied colours so transparent edges keep their colour.
			// Bilinear sampling uses a bounded four source pixels per output pixel.
			fx := (float64(x)+0.5)*float64(c.Width)/float64(width) - 0.5
			fy := (float64(y)+0.5)*float64(c.Height)/float64(height) - 0.5
			x0, y0 := max(0, int(fx)), max(0, int(fy))
			x1, y1 := min(c.Width-1, x0+1), min(c.Height-1, y0+1)
			dx, dy := max(0, fx-float64(x0)), max(0, fy-float64(y0))
			a := color.RGBAModel.Convert(pixelAt(x0, y0)).(color.RGBA)
			q := color.RGBAModel.Convert(pixelAt(x1, y0)).(color.RGBA)
			z := color.RGBAModel.Convert(pixelAt(x0, y1)).(color.RGBA)
			v := color.RGBAModel.Convert(pixelAt(x1, y1)).(color.RGBA)
			mix := func(a, b, c, d uint8) uint8 {
				return uint8((1-dy)*((1-dx)*float64(a)+dx*float64(b)) + dy*((1-dx)*float64(c)+dx*float64(d)) + 0.5)
			}
			target.SetRGBA(x, y, color.RGBA{mix(a.R, q.R, z.R, v.R), mix(a.G, q.G, z.G, v.G), mix(a.B, q.B, z.B, v.B), mix(a.A, q.A, z.A, v.A)})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, target); err != nil {
		return nil, errThumbnail
	}
	return buf.Bytes(), nil
}
