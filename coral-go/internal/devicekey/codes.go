package devicekey

import "errors"

// CodeInternal answers any error that is not one of the verifier's own: it says nothing of the error.
const CodeInternal = "internal"

// ReplyCodes is the one closed list of codes a signed-message reply may carry (coral-hub, slice 7 rule c): the verifier tests and the Hub's reply cut share it, so a code added on one side fails a test. A reply is {"error": code} with one of these, or the success shape; anything else is a fixed 502 at the Hub.
var ReplyCodes = []string{
	"bad_form", "bad_signature", "bad_mode", "top_mode", "above_signer", "self_target", "unknown_target", "target_bootstrap",
	"signer_bootstrap", "signer_no_proof", "nonce_repeat", "nonce_store_full", "list_unavailable", "key_limit",
	"ts_window", "before_start", "clock_back",
	"body_hash", "body_too_large", "wrong_request", "wrong_link", "outside_pair", // the relayed (v3) kinds, relayed.go (#20563)
	"cert_expired", "cert_epoch", "cert_not_allowed", // sign once (#21889)
	CodeInternal,
}

// FoldedCodes are verifier codes that a reply never carries as themselves: they would tell a sender who has not yet proved a key whether a kid is listed, was removed, or which computer this is. They reply bad_signature.
var FoldedCodes = map[string]bool{"unknown_signer": true, "signer_removed": true, "wrong_computer": true}

// InternalOnlyCodes are verifier errors that are the computer's own wiring fault, not anything about the message: a reply says only "internal" for them, never the name.
var InternalOnlyCodes = map[string]bool{"no_authority": true}

// InReplyCodes reports whether code is in the closed list.
func InReplyCodes(code string) bool {
	for _, c := range ReplyCodes {
		if c == code {
			return true
		}
	}
	return false
}

// ReplyCode is the code a reply carries for an error from the verifier.
func ReplyCode(err error) string {
	for _, e := range []error{ErrBadForm, ErrBadSignature, ErrBadMode, ErrTopMode, ErrAboveSigner, ErrSelfTarget, ErrUnknownTarget, ErrTargetBootstrap,
		ErrSignerBootstrap, ErrSignerNoProof, ErrNonceRepeat, ErrNonceStoreFull, ErrListUnavailable, ErrKeyLimit, ErrTsWindow, ErrBeforeStart, ErrClockBack,
		ErrBodyHash, ErrBodyTooLarge, ErrWrongRequest, ErrWrongLink, ErrOutsidePair, ErrCertExpired, ErrCertEpoch, ErrCertNotAllowed} {
		if errors.Is(err, e) {
			return e.Error()
		}
	}
	if errors.Is(err, ErrUnknownSigner) || errors.Is(err, ErrSignerRemoved) || errors.Is(err, ErrWrongComputer) {
		return "bad_signature"
	}
	return CodeInternal
}
