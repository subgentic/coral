package routes

import (
	"context"
	"strconv"
	"time"

	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/internal/store"
)

// deviceKeyNoticeWindow is how long a new or raised device key stays in the owner's Needs you.
const deviceKeyNoticeWindow = 24 * time.Hour

// DeviceKeyNoticeItems is the Needs you source of #20515 M4: each device key that a signed message or a passkey certificate added, or whose mode a signed message raised, in the last day, shown by the fingerprint the computer
// read from the key's own bytes and the label it recorded for who approved it. It reads the device list only; nothing here decides or changes a key.
func DeviceKeyNoticeItems(ss *store.SessionStore, now func() time.Time) func(ctx context.Context) ([]NeedsYouItem, error) {
	return func(ctx context.Context) ([]NeedsYouItem, error) {
		keys, err := ss.ListDeviceKeys(ctx)
		if err != nil {
			return nil, err
		}
		byKID := map[string]store.DeviceKey{}
		for _, k := range keys {
			byKID[k.KID] = k
		}
		cutoff := now().Add(-deviceKeyNoticeWindow).Unix()
		var items []NeedsYouItem
		label := func(kid string) string {
			if s, ok := byKID[kid]; ok {
				return "\"" + s.Label + "\""
			}
			return "a device"
		}
		for _, k := range keys {
			if k.RemovedAt != 0 || k.ChangedAt < cutoff {
				continue
			}
			fp := devicekey.DisplayFingerprint(k.PK)
			var line string
			switch {
			case k.RaisedBy == store.PairBrowserBy: // allowed here through the pair-a-browser flow (#21880): the person pressed Allow, and still sees what the key can now do
				line = label(k.KID) + " can now act on this computer as " + k.Mode + ": " + fp
			case k.RaisedBy == store.PairOwner:
				continue // raised here, by the person at this computer: nothing to tell them
			case k.RaisedBy != "": // a signed raise: the signer who raised it, whoever approved the key
				line = "A device key was raised by " + label(k.RaisedBy) + ": " + fp + ", access " + k.Mode
			case k.ApprovedBy == "":
				continue // made at this computer
			default:
				what := "A device key was added"
				if k.Kind == store.DeviceKindPasskey {
					what = "A passkey was trusted"
				}
				line = what + " by " + label(k.ApprovedBy) + ": " + fp + ", access " + k.Mode
			}
			items = append(items, NeedsYouItem{Kind: "device_key", Line: needsYouLine(line), ID: "device_key:" + k.KID + ":" + strconv.FormatInt(k.ChangedAt, 10), At: time.Unix(k.ChangedAt, 0).UTC().Format(time.RFC3339)})
		}
		return items, nil
	}
}
