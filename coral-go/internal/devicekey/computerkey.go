package devicekey

import (
	"crypto/ecdh"
	"crypto/rand"
	"errors"
	"io/fs"
	"runtime"

	"github.com/subgentic/coral/internal/safefs"
)

// ComputerKeyFile is the name of the one stored per-computer X25519 key inside the data folder. Only this package names it (a source scan test holds that): the key is identity only, never in status, logs, backups or Hub messages. Only its public half, computer_pub, leaves.
const ComputerKeyFile = "device-computer.key"

// On Windows there are no file modes: the data folder's ACL is what guards the key file.

// ErrComputerKeyFile is a key file Coral will not use: a link, others' access, a wrong size or content. It is never repaired by making a new key, because a new key is a new computer identity. The error text never holds file content.
var ErrComputerKeyFile = errors.New("the computer key file is not usable")

// ComputerKey is this computer's X25519 key.
type ComputerKey struct{ k *ecdh.PrivateKey }

// Pub is the 32 raw bytes of the public key (computer_pub).
func (c *ComputerKey) Pub() []byte { return c.k.PublicKey().Bytes() }

// Computer is the base64url SHA-256 of Pub: the value every signed message names.
func (c *ComputerKey) Computer() string { return ComputerFingerprint(c.Pub()) }

// LoadOrCreateComputerKey reads the key from dir, or makes it the first time. The file is 0600, opened through a root (no link out of the folder, one hard link), 43 base64url characters and a newline.
func LoadOrCreateComputerKey(dir string) (*ComputerKey, error) {
	root, err := safefs.OpenRoot(dir)
	if err != nil {
		return nil, ErrComputerKeyFile
	}
	defer root.Close()
	if _, err := root.Lstat(ComputerKeyFile); errors.Is(err, fs.ErrNotExist) {
		k, err := ecdh.X25519().GenerateKey(rand.Reader)
		if err != nil {
			return nil, err
		}
		f, err := root.CreateNew(ComputerKeyFile, 0o600)
		if err != nil {
			return nil, ErrComputerKeyFile
		}
		_, werr := f.WriteString(b64.EncodeToString(k.Bytes()) + "\n")
		cerr := f.Close()
		if werr != nil || cerr != nil {
			_ = root.Remove(ComputerKeyFile)
			return nil, ErrComputerKeyFile
		}
		return &ComputerKey{k: k}, nil
	} else if err != nil {
		return nil, ErrComputerKeyFile
	}
	f, fi, err := root.Open(ComputerKeyFile)
	if err != nil {
		return nil, ErrComputerKeyFile
	}
	f.Close()
	if runtime.GOOS != "windows" && fi.Mode().Perm()&0o077 != 0 {
		return nil, ErrComputerKeyFile
	}
	raw, err := root.ReadFileOneLink(ComputerKeyFile, 128)
	if err != nil {
		return nil, ErrComputerKeyFile
	}
	if len(raw) > 0 && raw[len(raw)-1] == '\n' {
		raw = raw[:len(raw)-1]
	}
	b, ok := fixedB64(string(raw), 43, 32)
	if !ok {
		return nil, ErrComputerKeyFile
	}
	k, err := ecdh.X25519().NewPrivateKey(b)
	if err != nil {
		return nil, ErrComputerKeyFile
	}
	return &ComputerKey{k: k}, nil
}
