//go:build darwin

package application

import "syscall"

// freeDiskBytes reports the space available to unprivileged users on the
// volume holding path — the live signal behind the Reserve check.
func freeDiskBytes(path string) (int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}
