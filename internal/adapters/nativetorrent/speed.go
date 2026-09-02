package nativetorrent

import (
	"time"
)

// speedMeter keeps an exponential moving average of per-second download
// deltas for one torrent.
type speedMeter struct {
	prev int64
	ema  float64
}

func (m *speedMeter) sample(read int64) float64 {
	delta := read - m.prev
	if delta < 0 {
		delta = 0 // counters can restart when a torrent is re-verified
	}
	m.prev = read
	m.ema = 0.7*m.ema + 0.3*float64(delta)
	return m.ema
}

// speedLoop samples every torrent's useful data counter once per second.
func (c *Client) speedLoop() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-c.stop:
			return
		case <-ticker.C:
			c.mu.Lock()
			for _, t := range c.cl.Torrents() {
				hash := t.InfoHash().HexString()
				m := c.speeds[hash]
				if m == nil {
					m = &speedMeter{}
					c.speeds[hash] = m
				}
				stats := t.Stats()
				m.sample(stats.BytesReadData.Int64())
			}
			c.mu.Unlock()
		}
	}
}

func (c *Client) stopSpeedLoop() { close(c.stop) }

func (c *Client) currentSpeed(hash string) int64 {
	if m := c.speeds[hash]; m != nil {
		return int64(m.ema)
	}
	return 0
}
