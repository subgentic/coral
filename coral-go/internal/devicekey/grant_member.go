package devicekey

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/store"
)

// The owner-only relayed kinds (#20649, Hub Security's MUSTs on #262424). A relayed signature always covers the body by hash; these two kinds add what that alone does not say.
//
//   - grant-member: POST /api/member-grants carries the whole grant (grantee, level, scope, days) in its body, and the relayed signature covers that body by hash. It is signed only by the owner's own key (a grantee's key
//     never signs a grant), and the kid of the signature inside the body is the relayed signer's own.
//   - hub-auto-accept: the value the toggle sets is in the signed query (?allow=true or ?allow=false), so the signer sees the result in what they sign; the body is empty or says the same.

// ownerOnly is the kinds whose relayed signer must be the owner's key.
var ownerOnly = map[Kind]bool{GrantMember: true, HubAutoAccept: true}

// OwnerOnly reports whether a kind may be signed only by the owner's own key.
func OwnerOnly(k Kind) bool { return ownerOnly[k] }

// AutoAcceptQuery is the one query of a signed hub-auto-accept request, and the value it names: exactly allow=true or allow=false, nothing else. ok is false for any other query, a repeated key, or none.
func AutoAcceptQuery(target string) (allow, ok bool) {
	i := strings.IndexByte(target, '?')
	if i < 0 {
		return false, false
	}
	q := target[i+1:]
	switch q {
	case "allow=true":
		return true, true
	case "allow=false":
		return false, true
	}
	return false, false
}

// GrantMemberAuthorizer is the authorize function for a request that came through a Hub link and may be a grant-member or hub-auto-accept one. It is RelayedAuthorizer plus, for the owner-only kinds:
//  1. the signer is the owner's own key: a key bound to a Hub person never signs one (outside_pair);
//  2. grant-member POST: the body names a signature whose kid is the relayed signer's, so the key that signed the request is the key that signed the grant (outside_pair);
//  3. hub-auto-accept: the target carries exactly ?allow=true or ?allow=false, and the body is empty or {"allow": <the same value>}; a body that disagrees is refused (wrong_request), never merged.
//
// body is the exact bytes whose hash HandleRelayedOn checks. Every other kind passes through unchanged.
func GrantMemberAuthorizer(actor string, pin OwnerPinFunc, body []byte) func(Relayed, store.DeviceKey) error {
	base := RelayedAuthorizer(actor, pin)
	return func(m Relayed, signer store.DeviceKey) error {
		if err := base(m, signer); err != nil {
			return err
		}
		if !ownerOnly[m.Kind] {
			return nil
		}
		if owner, _ := signer.PairState(); !owner {
			return ErrOutsidePair
		}
		switch m.Kind {
		case GrantMember:
			if m.Method != "POST" {
				return nil // DELETE names the grant in the signed path
			}
			var b struct {
				Signature struct {
					KID string `json:"kid"`
				} `json:"signature"`
			}
			if err := json.Unmarshal(body, &b); err != nil || b.Signature.KID == "" || b.Signature.KID != m.KID {
				return ErrOutsidePair
			}
		case HubAutoAccept:
			want, ok := AutoAcceptQuery(m.Path)
			if !ok {
				return ErrWrongRequest
			}
			if len(bytes.TrimSpace(body)) > 0 {
				var b struct {
					Allow *bool `json:"allow"`
				}
				if err := json.Unmarshal(body, &b); err != nil || b.Allow == nil || *b.Allow != want {
					return ErrWrongRequest
				}
			}
		}
		return nil
	}
}

// grantLabel starts the text the owner's device signs for a grant, so a signature for a grant is never one of another message and carries this computer.
const grantLabel = "coral-hub/device-keys/3/grant-member-owner\x00"

// GrantSigningInput is what the owner's device signs for one grant: a fixed label, this computer's fingerprint, then the grant's digest (board.MemberGrantDigest, which holds the link, the grantee, the level, the scope, the
// days, a nonce and the time). A signature made for another computer is not this computer's.
func GrantSigningInput(computer string, digest []byte) []byte {
	out := make([]byte, 0, len(grantLabel)+len(computer)+1+len(digest))
	out = append(out, grantLabel...)
	out = append(out, computer...)
	out = append(out, '\n')
	return append(out, digest...)
}

// VerifyOwnerGrant is the memberVerify of the grant route: kid is an active device of this computer's owner (Kind device, the owner's own pair, never a key bound to a Hub person) and sig is its signature over
// GrantSigningInput(this computer, digest). It returns the signer's mode, read from the computer's own list. The digest is recomputed by the caller from the received body's own fields.
func (v *Verifier) VerifyOwnerGrant(ctx context.Context, digest []byte, kid, sig string, now time.Time) (string, error) {
	if v.Refuse != nil && v.Refuse() {
		return "", ErrListUnavailable
	}
	signer, err := v.Store.ActiveDeviceKey(ctx, kid, now)
	if err != nil {
		return "", mapStoreErr(err)
	}
	if signer.Kind != store.DeviceKindDevice {
		return "", ErrUnknownSigner
	}
	if owner, _ := signer.PairState(); !owner {
		return "", ErrOutsidePair
	}
	if !verifyP1363(signer.PK, GrantSigningInput(v.Computer, digest), sig) {
		return "", ErrBadSignature
	}
	return signer.Mode, nil
}
