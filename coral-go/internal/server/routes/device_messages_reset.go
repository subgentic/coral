package routes

// ResetDeviceMessageLimits forgets every failed-check count of the device-key messages. The counts are process-wide (a bucket per link and signer), so a test in another package that fails requests on purpose
// calls it first, so what other tests spent in the same minute is not charged to it. Nothing in the server calls it.
func ResetDeviceMessageLimits() {
	deviceMsgLimiter.mu.Lock()
	defer deviceMsgLimiter.mu.Unlock()
	deviceMsgLimiter.by = nil
}
