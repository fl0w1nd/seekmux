package store

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	// EncryptionKeyEnv names the variable that supplies the encryption key in
	// place of the key file.
	EncryptionKeyEnv = "SEEKMUX_ENCRYPTION_KEY"
	keyFile          = "encryption.key"
	sealedPrefix     = "enc:v1:"
)

// loadKey returns the key that seals values at rest. The environment wins;
// without it the key lives in a file beside the database, created on first
// run. The database alone, in a backup or a copy, then gives nothing away.
func loadKey(dir string) ([]byte, error) {
	secret := strings.TrimSpace(os.Getenv(EncryptionKeyEnv))
	if secret == "" {
		path := filepath.Join(dir, keyFile)
		data, err := os.ReadFile(path)
		switch {
		case errors.Is(err, os.ErrNotExist):
			raw := make([]byte, 32)
			if _, err := rand.Read(raw); err != nil {
				return nil, err
			}
			data = []byte(base64.RawStdEncoding.EncodeToString(raw) + "\n")
			if err := os.WriteFile(path, data, 0o600); err != nil {
				return nil, fmt.Errorf("create encryption key %s: %w", path, err)
			}
		case err != nil:
			return nil, fmt.Errorf("read encryption key %s: %w", path, err)
		}
		if secret = strings.TrimSpace(string(data)); secret == "" {
			return nil, fmt.Errorf("encryption key %s is empty", path)
		}
	}
	key := sha256.Sum256([]byte(secret))
	return key[:], nil
}

// Sealed reports whether value was written by Seal.
func Sealed(value []byte) bool { return bytes.HasPrefix(value, []byte(sealedPrefix)) }

// Seal encrypts value with AES-256-GCM. name is the key it is stored under
// and is authenticated with it, so a sealed value cannot be moved to another.
func (s *Store) Seal(name string, value []byte) ([]byte, error) {
	aead, err := s.aead()
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	sealed := aead.Seal(nonce, nonce, value, []byte(name))
	return []byte(sealedPrefix + base64.RawStdEncoding.EncodeToString(sealed)), nil
}

// Unseal reverses Seal. A value from before encryption is returned as it is.
func (s *Store) Unseal(name string, value []byte) ([]byte, error) {
	if !Sealed(value) {
		return value, nil
	}
	aead, err := s.aead()
	if err != nil {
		return nil, err
	}
	raw, err := base64.RawStdEncoding.DecodeString(string(value[len(sealedPrefix):]))
	if err != nil || len(raw) < aead.NonceSize() {
		return nil, errors.New("encrypted value is damaged")
	}
	plain, err := aead.Open(nil, raw[:aead.NonceSize()], raw[aead.NonceSize():], []byte(name))
	if err != nil {
		return nil, fmt.Errorf("cannot decrypt with this encryption key; restore the %s file or %s the value was written with", keyFile, EncryptionKeyEnv)
	}
	return plain, nil
}

func (s *Store) aead() (cipher.AEAD, error) {
	block, err := aes.NewCipher(s.key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// Compact rewrites the database file, so that what a value held before it
// was replaced is not left behind in free pages or the write-ahead log.
func (s *Store) Compact() {
	_, _ = s.db.Exec(`VACUUM`)
	_, _ = s.db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`)
}
