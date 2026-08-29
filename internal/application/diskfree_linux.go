//go:build linux

package application

import "syscall"

// freeDiskBytes reports the space available to unprivileged users on the
// volume holding path — the live signal behind the Reserve check.
func freeDiskBytes(path string) (int64, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, err
	}
	return int64(stat.Bavail) * stat.Bsize, nil
}
