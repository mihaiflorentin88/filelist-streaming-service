//go:build !linux

package application

import "errors"

// freeDiskBytes has no implementation off Linux; the Reserve check is skipped
// with a warning wherever the probe is unavailable.
func freeDiskBytes(string) (int64, error) {
	return 0, errors.New("free-space probe is unsupported on this platform")
}
