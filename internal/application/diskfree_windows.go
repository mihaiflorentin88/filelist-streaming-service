//go:build windows

package application

import "golang.org/x/sys/windows"

// freeDiskBytes reports the space available to unprivileged users on the
// volume holding path — the live signal behind the Reserve check.
func freeDiskBytes(path string) (int64, error) {
	var free, total, avail uint64
	if err := windows.GetDiskFreeSpaceEx(windows.StringToUTF16Ptr(path), &free, &total, &avail); err != nil {
		return 0, err
	}
	return int64(avail), nil
}
