package devicekey

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/hkdf"
)

// #20966 (design #20901 v8, coral-hub's MUST): a value a relayed kind returns (a new request key, an Allow code) goes back only sealed to the one-time X25519 key the browser put in the signed query, bound to the
// relayed request and the object, so a Hub relaying the answer holds ciphertext. openBox is the browser's side, written here from the format alone.

func openBox(t *testing.T, priv *ecdh.PrivateKey, box []byte, purpose, nonce, object string) ([]byte, error) {
	t.Helper()
	var b struct {
		V     int    `json:"v"`
		EPK   string `json:"epk"`
		Nonce string `json:"nonce"`
		CT    string `json:"ct"`
	}
	require.NoError(t, json.Unmarshal(box, &b))
	require.Equal(t, 1, b.V)
	epk, err := b64.DecodeString(b.EPK)
	require.NoError(t, err)
	n, err := b64.DecodeString(b.Nonce)
	require.NoError(t, err)
	ct, err := b64.DecodeString(b.CT)
	require.NoError(t, err)
	pub, err := ecdh.X25519().NewPublicKey(epk)
	require.NoError(t, err)
	shared, err := priv.ECDH(pub)
	require.NoError(t, err)
	salt := append(append([]byte{}, epk...), priv.PublicKey().Bytes()...)
	key := make([]byte, 32)
	_, _ = io.ReadFull(hkdf.New(sha256.New, shared, salt, []byte("coral/link-box/1")), key)
	blk, err := aes.NewCipher(key)
	require.NoError(t, err)
	gcm, err := cipher.NewGCM(blk)
	require.NoError(t, err)
	return gcm.Open(nil, n, ct, []byte("coral/link-box/1\x00"+purpose+"\x00"+nonce+"\x00"+object))
}

func browserKey(t *testing.T) (*ecdh.PrivateKey, string) {
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	require.NoError(t, err)
	return priv, b64.EncodeToString(priv.PublicKey().Bytes())
}

func TestASealedBoxOpensOnlyWithTheBrowsersKeyAndItsOwnRequest(t *testing.T) {
	priv, pk := browserKey(t)
	secret := "lr" + "k_0123abcd_" + strings.Repeat("f", 32)
	box, err := SealBox(pk, "make-link-key", "NONCEnonceNONCEnonce22", "lk-aaaa1111", []byte(secret))
	require.NoError(t, err)
	assert.NotContains(t, string(box), secret, "the box never carries the value in the clear")
	assert.NotContains(t, string(box), "0123abcd")
	got, err := openBox(t, priv, box, "make-link-key", "NONCEnonceNONCEnonce22", "lk-aaaa1111")
	require.NoError(t, err)
	assert.Equal(t, secret, string(got))

	_, err = openBox(t, priv, box, "allow-link", "NONCEnonceNONCEnonce22", "lk-aaaa1111")
	assert.Error(t, err, "another purpose")
	_, err = openBox(t, priv, box, "make-link-key", "OTHERnonceOTHERnonce22", "lk-aaaa1111")
	assert.Error(t, err, "another relayed request")
	_, err = openBox(t, priv, box, "make-link-key", "NONCEnonceNONCEnonce22", "lk-bbbb2222")
	assert.Error(t, err, "another object (key or request id)")
	other, _ := browserKey(t)
	_, err = openBox(t, other, box, "make-link-key", "NONCEnonceNONCEnonce22", "lk-aaaa1111")
	assert.Error(t, err, "another key")

	box2, err := SealBox(pk, "make-link-key", "NONCEnonceNONCEnonce22", "lk-aaaa1111", []byte(secret))
	require.NoError(t, err)
	assert.NotEqual(t, string(box), string(box2), "a fresh ephemeral key and nonce each time")
}

func TestASealNeedsAGoodKeyAndSealsNothingWithoutOne(t *testing.T) {
	for name, pk := range map[string]string{"empty": "", "short": "AAAA", "not base64url": strings.Repeat("!", 43), "padded": strings.Repeat("A", 43) + "=", "all zero (a low-order point)": b64.EncodeToString(make([]byte, 32))} {
		box, err := SealBox(pk, "allow-link", "NONCEnonceNONCEnonce22", "lr-x", []byte("12345678"))
		assert.ErrorIs(t, err, ErrBoxKey, name)
		assert.Nil(t, box, name)
	}
	assert.False(t, BoxKeyOK(""))
	_, pk := browserKey(t)
	assert.True(t, BoxKeyOK(pk))
}
