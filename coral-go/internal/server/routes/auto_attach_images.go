// The image side of auto-attach: the type by magic bytes, the pixel limits, and the metadata strippers for JPEG, PNG, WebP and GIF (no re-encoding). Moved out of auto_attach.go (#8314), no code changed.

package routes

import (
	"bytes"
	"encoding/binary"
	"image"
	"net/http"
)

// sniffImage is the content's image type by its magic bytes ("" if not one of ours).
func sniffImage(data []byte) string {
	switch t := http.DetectContentType(data); t {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return t
	}
	return ""
}

// checkPixels refuses an image larger than attachMaxSide on a side or attachMaxPixels in all.
func checkPixels(data []byte, mediaType string) error {
	var w, h int
	if mediaType == "image/webp" {
		var ok bool
		if w, h, ok = webpSize(data); !ok {
			return errAttach("bad_image")
		}
	} else {
		cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil {
			return errAttach("bad_image")
		}
		w, h = cfg.Width, cfg.Height
	}
	if w <= 0 || h <= 0 || w > attachMaxSide || h > attachMaxSide || int64(w)*int64(h) > attachMaxPixels {
		return errAttach("too_many_pixels")
	}
	return nil
}

// webpSize reads a WebP's canvas size from its first chunk (VP8X, VP8 or VP8L).
func webpSize(d []byte) (int, int, bool) {
	if len(d) < 30 || string(d[0:4]) != "RIFF" || string(d[8:12]) != "WEBP" {
		return 0, 0, false
	}
	c := d[20:]
	switch string(d[12:16]) {
	case "VP8X":
		w := int(c[4]) | int(c[5])<<8 | int(c[6])<<16
		h := int(c[7]) | int(c[8])<<8 | int(c[9])<<16
		return w + 1, h + 1, true
	case "VP8 ":
		if c[3] != 0x9d || c[4] != 0x01 || c[5] != 0x2a {
			return 0, 0, false
		}
		return int(binary.LittleEndian.Uint16(c[6:8]) & 0x3fff), int(binary.LittleEndian.Uint16(c[8:10]) & 0x3fff), true
	case "VP8L":
		if c[0] != 0x2f {
			return 0, 0, false
		}
		b := binary.LittleEndian.Uint32(c[1:5])
		return int(b&0x3fff) + 1, int((b>>14)&0x3fff) + 1, true
	}
	return 0, 0, false
}

// stripImageMetadata removes location and camera metadata without re-encoding:
//   - JPEG: only whitelisted segments (jpegKeep), cut at the EOI;
//   - PNG: every chunk but the critical ones and those that only affect display (pngKeep),
//     cut at IEND;
//   - WebP: an EXIF or XMP chunk is refused rather than rewritten (the container's
//     flags would need editing);
//   - GIF: comment, plain-text and application extensions dropped, cut at the trailer.
func stripImageMetadata(data []byte, mediaType string) ([]byte, error) {
	if len(data) > stripMaxInput {
		return nil, errAttach("too_large")
	}
	switch mediaType {
	case "image/jpeg":
		return stripJPEG(data)
	case "image/gif":
		return stripGIF(data)
	case "image/png":
		return stripPNGText(data)
	case "image/webp":
		for off := 12; off+8 <= len(data); {
			id := string(data[off : off+4])
			n := int(binary.LittleEndian.Uint32(data[off+4 : off+8]))
			if id == "EXIF" || id == "XMP " {
				return nil, errAttach("webp_metadata")
			}
			if n < 0 || n > len(data) {
				return nil, errAttach("bad_image")
			}
			off += 8 + n + n&1
		}
	}
	return data, nil
}

// The strippers' resource limits (#4380). They walk the file's structure once and decode nothing (no
// pixels, no decompression), so time and memory are linear in the input and a decompression bomb has
// nothing to inflate; these bound the input and the number of structural elements a hostile file can make
// them visit, and the output never exceeds the input.
const (
	stripMaxInput    = 64 << 20 // the artifact store's own maximum
	stripMaxElements = 1 << 20  // JPEG segments, PNG chunks or GIF blocks in one file
)

// jpegKeep reports whether a JPEG marker segment is kept whole: APP2 only with an ICC profile,
// and the table, frame, restart-interval and scan segments. Everything else (APP1 EXIF/XMP,
// APP3-13 incl. IPTC, MPF thumbnails in APP2, APP11 C2PA, APP15, COM, ...) is dropped.
// APP0 (JFIF) and APP14 (Adobe colour transform) are not kept whole either: jpegHeaderOnly
// keeps just their fixed header, since both can carry more than that (a JFIF thumbnail, a
// JFXX thumbnail, free text; #5393).
func jpegKeep(marker byte, payload []byte) bool {
	switch {
	case marker == 0xE2: // APP2: only an ICC profile
		return bytes.HasPrefix(payload, []byte("ICC_PROFILE\x00"))
	case marker == 0xDB, marker == 0xC4, marker == 0xCC, marker == 0xDD, marker == 0xDA: // DQT, DHT, DAC, DRI, SOS
		return true
	case marker >= 0xC0 && marker <= 0xCF: // SOFn (C4, C8, CC handled above or reserved)
		return marker != 0xC8
	}
	return false
}

// jpegHeaderOnly is what is kept of an APP0 or APP14 segment, or nil when none of it is: a JFIF header (its identifier, version, density
// units and density: 12 bytes) with the thumbnail size set to 0 x 0 and no thumbnail data after it (a JFIF thumbnail is a small copy of the picture
// as it was, which a cropped or redacted photo must not keep); an Adobe segment's 12 fixed bytes. A JFXX extension (a thumbnail in JPEG or
// palette form), any other APP0 and an APP14 of another kind are dropped. Nothing of the picture itself is touched.
func jpegHeaderOnly(marker byte, payload []byte) []byte {
	switch {
	case marker == 0xE0 && len(payload) >= 14 && bytes.HasPrefix(payload, []byte("JFIF\x00")):
		return append(append(make([]byte, 0, 14), payload[:12]...), 0, 0)
	case marker == 0xEE && len(payload) >= 12 && bytes.HasPrefix(payload, []byte("Adobe")):
		return payload[:12:12]
	}
	return nil
}

// jpegExifOrientation is the Orientation tag (0x0112) of the EXIF block in an APP1 payload, 2 to 8, or 0 when there is none, it is 1 (upright) or the block cannot be read.
// A phone photo says "rotate me" in this one tag; dropping all of EXIF with the GPS would show a portrait photo on its side.
func jpegExifOrientation(p []byte) int {
	if len(p) < 14 || string(p[:6]) != "Exif\x00\x00" {
		return 0
	}
	t := p[6:]
	var bo binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 0
	}
	if bo.Uint16(t[2:4]) != 42 {
		return 0
	}
	ifd := int(bo.Uint32(t[4:8]))
	if ifd < 8 || ifd+2 > len(t) {
		return 0
	}
	n := int(bo.Uint16(t[ifd : ifd+2]))
	for k := 0; k < n && k < 1024; k++ {
		e := ifd + 2 + k*12
		if e+12 > len(t) {
			return 0
		}
		if bo.Uint16(t[e:e+2]) != 0x0112 {
			continue
		}
		if bo.Uint16(t[e+2:e+4]) != 3 || bo.Uint32(t[e+4:e+8]) != 1 {
			return 0
		}
		if v := int(bo.Uint16(t[e+8 : e+10])); v >= 2 && v <= 8 {
			return v
		}
		return 0
	}
	return 0
}

// jpegOrientationSegment is an APP1 segment that holds the Orientation tag and nothing else (no GPS, no camera, no thumbnail), or nil for no orientation to keep.
func jpegOrientationSegment(orientation int) []byte {
	if orientation < 2 || orientation > 8 {
		return nil
	}
	seg := []byte{0xFF, 0xE1, 0x00, 0x22} // length 34: itself (2), "Exif\0\0" (6), the TIFF header (8), one entry (2 + 12 + 4)
	seg = append(seg, "Exif\x00\x00"...)
	seg = append(seg, 'M', 'M', 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08)
	seg = append(seg, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, byte(orientation), 0x00, 0x00)
	seg = append(seg, 0x00, 0x00, 0x00, 0x00)
	return seg
}

// stripJPEG keeps only the whitelisted segments (jpegKeep) and the entropy-coded scan data,
// and ends the output at the EOI that ends the image: anything appended after it (another
// file, a polyglot, trailing data) is dropped. Nothing is re-encoded.
func stripJPEG(d []byte) ([]byte, error) {
	if len(d) < 4 || d[0] != 0xFF || d[1] != 0xD8 {
		return nil, errAttach("bad_image")
	}
	out := make([]byte, 0, len(d))
	out = append(out, 0xFF, 0xD8)
	i := 2
	scanned := false
	orientation := 0 // the EXIF Orientation (2 to 8; 1 is the default and needs no tag), kept below as a segment of its own (#5284)
	for elements := 0; i+2 <= len(d); elements++ {
		if elements > stripMaxElements {
			return nil, errAttach("bad_image")
		}
		if d[i] != 0xFF {
			return nil, errAttach("bad_image")
		}
		marker := d[i+1]
		switch {
		case marker == 0xFF: // fill byte
			i++
			continue
		case marker == 0xD9: // EOI: the end of the image
			if !scanned {
				return nil, errAttach("bad_image")
			}
			if seg := jpegOrientationSegment(orientation); seg != nil {
				out = append(out[:2], append(seg, out[2:]...)...) // right after SOI
			}
			return append(out, 0xFF, 0xD9), nil
		case marker >= 0xD0 && marker <= 0xD7, marker == 0x01: // no length
			return nil, errAttach("bad_image")
		}
		if i+4 > len(d) {
			return nil, errAttach("bad_image")
		}
		n := int(binary.BigEndian.Uint16(d[i+2 : i+4]))
		if n < 2 || i+2+n > len(d) {
			return nil, errAttach("bad_image")
		}
		seg := d[i : i+2+n]
		if marker == 0xE1 && orientation == 0 {
			orientation = jpegExifOrientation(d[i+4 : i+2+n])
		}
		if hdr := jpegHeaderOnly(marker, d[i+4:i+2+n]); hdr != nil {
			out = append(out, 0xFF, marker, byte((len(hdr)+2)>>8), byte(len(hdr)+2))
			out = append(out, hdr...)
		} else if jpegKeep(marker, d[i+4:i+2+n]) {
			out = append(out, seg...)
		}
		i += 2 + n
		if marker != 0xDA {
			continue
		}
		// Entropy-coded data after SOS runs to the next marker that isn't a stuffed 0x00 or
		// a restart marker.
		start := i
		for i+1 < len(d) {
			if d[i] == 0xFF && d[i+1] != 0x00 && !(d[i+1] >= 0xD0 && d[i+1] <= 0xD7) {
				break
			}
			i++
		}
		if i+1 >= len(d) {
			return nil, errAttach("bad_image") // no EOI
		}
		out = append(out, d[start:i]...)
		scanned = true
	}
	return nil, errAttach("bad_image")
}

// pngKeep: the critical chunks and the ancillary ones that only affect how the image
// looks; every other chunk (eXIf, tEXt, zTXt, iTXt, tIME, private chunks) is dropped.
var pngKeep = map[string]bool{
	"IHDR": true, "PLTE": true, "IDAT": true, "IEND": true,
	"tRNS": true, "gAMA": true, "cHRM": true, "sRGB": true, "iCCP": true, "sBIT": true, "bKGD": true, "pHYs": true,
	"acTL": true, "fcTL": true, "fdAT": true, // APNG frames
}

func stripPNGText(d []byte) ([]byte, error) {
	const sig = "\x89PNG\r\n\x1a\n"
	if len(d) < 8 || string(d[:8]) != sig {
		return nil, errAttach("bad_image")
	}
	out := append(make([]byte, 0, len(d)), d[:8]...)
	for i, elements := 8, 0; i < len(d); elements++ {
		if i+12 > len(d) || elements > stripMaxElements {
			return nil, errAttach("bad_image")
		}
		n := int(binary.BigEndian.Uint32(d[i : i+4]))
		if n < 0 || int64(i)+12+int64(n) > int64(len(d)) { // 64-bit: a chunk length near 4 GiB cannot wrap on a 32-bit int
			return nil, errAttach("bad_image")
		}
		typ := string(d[i+4 : i+8])
		if pngKeep[typ] {
			out = append(out, d[i:i+12+n]...)
		}
		i += 12 + n
		if typ == "IEND" {
			return out, nil // nothing after IEND is kept
		}
	}
	return nil, errAttach("bad_image") // no IEND
}

// stripGIF drops comment, plain-text and application extensions (NETSCAPE looping
// included, so an animation plays once) and ends the output at the trailer: anything
// appended after it is dropped. Image data and graphic control extensions are kept as is.
func stripGIF(d []byte) ([]byte, error) {
	if len(d) < 13 || (string(d[:6]) != "GIF87a" && string(d[:6]) != "GIF89a") {
		return nil, errAttach("bad_image")
	}
	i := 13
	if d[10]&0x80 != 0 { // global colour table
		i += 3 << (d[10]&0x07 + 1)
	}
	if i > len(d) {
		return nil, errAttach("bad_image")
	}
	out := append(make([]byte, 0, len(d)), d[:i]...)
	// subBlocks returns the end of the data sub-blocks starting at j.
	subBlocks := func(j int) (int, bool) {
		for j < len(d) {
			n := int(d[j])
			j++
			if n == 0 {
				return j, true
			}
			j += n
		}
		return 0, false
	}
	for blocks := 0; i < len(d); blocks++ {
		if blocks > stripMaxElements {
			return nil, errAttach("bad_image")
		}
		switch d[i] {
		case 0x3B: // trailer
			return append(out, 0x3B), nil
		case 0x21: // extension
			if i+2 > len(d) {
				return nil, errAttach("bad_image")
			}
			end, ok := subBlocks(i + 2)
			if !ok {
				return nil, errAttach("bad_image")
			}
			if d[i+1] == 0xF9 { // graphic control: timing and transparency
				out = append(out, d[i:end]...)
			}
			i = end
		case 0x2C: // image descriptor
			j := i + 10
			if j > len(d) {
				return nil, errAttach("bad_image")
			}
			if d[i+9]&0x80 != 0 { // local colour table
				j += 3 << (d[i+9]&0x07 + 1)
			}
			j++ // LZW minimum code size
			end, ok := subBlocks(j)
			if !ok || j > len(d) {
				return nil, errAttach("bad_image")
			}
			out = append(out, d[i:end]...)
			i = end
		default:
			return nil, errAttach("bad_image")
		}
	}
	return nil, errAttach("bad_image") // no trailer
}
