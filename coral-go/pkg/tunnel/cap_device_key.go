package tunnel

// CapDeviceKey is the capability "device_key/1" in Hello.Capabilities (#16726, agreed with coral-hub: singular, name/version): this Coral has a device key and knows what the Hub does with it. It is said only when
// both are true, so a build with part of the feature never claims it (ClientOptions.DeviceKey).
const CapDeviceKey = "device_key/1"
