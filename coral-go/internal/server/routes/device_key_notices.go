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
		for _, k := range keys {
			if k.RemovedAt != 0 || k.ApprovedBy == "" || k.ChangedAt < cutoff {
				continue
			}
			by := "a device"
			if s, ok := byKID[k.ApprovedBy]; ok {
				by = "\"" + s.Label + "\""
			}
			what := "A device key was added"
			if k.Kind == store.DeviceKindPasskey {
				what = "A passkey was trusted"
			}
			line := what + " by " + by + ": " + devicekey.DisplayFingerprint(k.PK) + ", access " + k.Mode
			if k.ChangedAt > k.CreatedAt {
				line = "A device key was raised by " + by + ": " + devicekey.DisplayFingerprint(k.PK) + ", access " + k.Mode
			}
			items = append(items, NeedsYouItem{Kind: "device_key", Line: needsYouLine(line), ID: "device_key:" + k.KID + ":" + strconv.FormatInt(k.ChangedAt, 10), At: time.Unix(k.ChangedAt, 0).UTC().Format(time.RFC3339Nano)})
		}
		return items, nil
	}
}
