package routes

// Opt-in reproducible fixtures/probe for Security's decoder ceiling check. Generate
// in one test process, then measure a fresh process per format with /usr/bin/time.
import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/png"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
)

func thumbnailPNGChunk(out *bytes.Buffer, kind string, data []byte) {
	_ = binary.Write(out, binary.BigEndian, uint32(len(data)))
	out.WriteString(kind)
	out.Write(data)
	h := crc32.NewIEEE()
	_, _ = h.Write([]byte(kind))
	_, _ = h.Write(data)
	_ = binary.Write(out, binary.BigEndian, h.Sum32())
}
func thumbnailInterlacedPNG(width, height int) []byte {
	var out, scan, packed bytes.Buffer
	out.WriteString("\x89PNG\r\n\x1a\n")
	head := make([]byte, 13)
	binary.BigEndian.PutUint32(head, uint32(width))
	binary.BigEndian.PutUint32(head[4:], uint32(height))
	head[8] = 8
	head[9] = 6
	head[12] = 1
	thumbnailPNGChunk(&out, "IHDR", head)
	for _, pass := range [][4]int{{0, 0, 8, 8}, {4, 0, 8, 8}, {0, 4, 4, 8}, {2, 0, 4, 4}, {0, 2, 2, 4}, {1, 0, 2, 2}, {0, 1, 1, 2}} {
		for y := pass[1]; y < height; y += pass[3] {
			scan.WriteByte(0)
			for x := pass[0]; x < width; x += pass[2] {
				scan.Write([]byte{byte(x), byte(y), byte(x + y), 255})
			}
		}
	}
	z := zlib.NewWriter(&packed)
	_, _ = z.Write(scan.Bytes())
	_ = z.Close()
	thumbnailPNGChunk(&out, "IDAT", packed.Bytes())
	thumbnailPNGChunk(&out, "IEND", nil)
	return out.Bytes()
}
func thumbnailProgressiveJPEG(width, height int) []byte {
	var out bytes.Buffer
	out.Write([]byte{255, 216})
	marker := func(kind byte, data []byte) {
		out.Write([]byte{255, kind})
		_ = binary.Write(&out, binary.BigEndian, uint16(len(data)+2))
		out.Write(data)
	}
	quant := append([]byte{0}, bytes.Repeat([]byte{1}, 64)...)
	marker(0xdb, quant)
	sof := []byte{8, byte(height >> 8), byte(height), byte(width >> 8), byte(width), 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0}
	marker(0xc2, sof)
	// One zero-bit code each for DC category zero and AC EOB: constant pixels.
	huff := []byte{0, 1}
	huff = append(huff, make([]byte, 15)...)
	huff = append(huff, 0, 0x10, 1)
	huff = append(huff, make([]byte, 15)...)
	huff = append(huff, 0)
	marker(0xc4, huff)
	bits := func(n int) {
		out.Write(make([]byte, n/8))
		if n%8 != 0 {
			out.WriteByte(byte((1 << (8 - n%8)) - 1))
		}
	}
	blocks := ((width + 7) / 8) * ((height + 7) / 8)
	marker(0xda, []byte{3, 1, 0, 2, 0, 3, 0, 0, 0, 0})
	bits(3 * blocks)
	for id := byte(1); id <= 3; id++ {
		marker(0xda, []byte{1, id, 0, 1, 63, 0})
		bits(blocks)
	}
	out.Write([]byte{255, 217})
	return out.Bytes()
}
func TestThumbnailGenerateMemoryFixtures(t *testing.T) {
	dir := os.Getenv("CORAL_THUMB_FIXTURE_DIR")
	if dir == "" {
		t.Skip("opt-in fixture generation")
	}
	require.NoError(t, os.MkdirAll(dir, 0700))
	const width, height = 2000, 1500 // exactly 3 million pixels, the revised ceiling
	img := image.NewNRGBA64(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.SetNRGBA64(x, y, color.NRGBA64{uint16(x * 29), uint16(y * 31), uint16(x + y), 65535})
		}
	}
	var png16 bytes.Buffer
	require.NoError(t, png.Encode(&png16, img))
	palette := image.NewPaletted(image.Rect(0, 0, width, height), color.Palette{color.Black, color.White})
	var gifData bytes.Buffer
	require.NoError(t, gif.Encode(&gifData, palette, nil))
	for name, raw := range map[string][]byte{"png16": png16.Bytes(), "png-interlaced": thumbnailInterlacedPNG(width, height), "jpeg-progressive": thumbnailProgressiveJPEG(width, height), "gif": gifData.Bytes()} {
		require.LessOrEqual(t, len(raw), thumbnailInputLimit, name)
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), raw, 0600))
	}
}
func TestThumbnailMemoryPair(t *testing.T) {
	path := os.Getenv("CORAL_THUMB_MEMORY_FILE")
	if path == "" {
		t.Skip("opt-in fresh-process peak RSS measurement")
	}
	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	var group sync.WaitGroup
	errs := make(chan error, 2)
	start := make(chan struct{})
	for i := 0; i < 2; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			data, err := makeThumbnail(bytes.NewReader(raw))
			if err == nil {
				_, err = png.Decode(bytes.NewReader(data))
			}
			errs <- err
		}()
	}
	close(start)
	group.Wait()
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
}
