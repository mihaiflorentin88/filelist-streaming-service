package outbound

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type RateLimitError struct {
	Provider string
	RetryAt  time.Time
	Attempts int
	Detail   string
}

func (e *RateLimitError) Error() string {
	if !e.RetryAt.IsZero() {
		return fmt.Sprintf("%s rate limited until %s", e.Provider, e.RetryAt.Format(time.RFC3339))
	}
	return e.Provider + " rate limited"
}
func IsRateLimited(err error) bool { var target *RateLimitError; return errors.As(err, &target) }

type Policy struct {
	Provider       string
	Attempts       int
	MaxInlineDelay time.Duration
}

func Do(ctx context.Context, client *http.Client, makeRequest func() (*http.Request, error), policy Policy) (*http.Response, error) {
	if policy.Attempts < 1 {
		policy.Attempts = 3
	}
	if policy.MaxInlineDelay <= 0 {
		policy.MaxInlineDelay = 15 * time.Second
	}
	var last *RateLimitError
	for attempt := 1; attempt <= policy.Attempts; attempt++ {
		req, err := makeRequest()
		if err != nil {
			return nil, err
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != http.StatusTooManyRequests {
			return resp, nil
		}
		resp.Body.Close()
		delay := retryDelay(resp.Header, attempt)
		last = &RateLimitError{Provider: policy.Provider, RetryAt: time.Now().Add(delay), Attempts: attempt, Detail: "HTTP 429"}
		if attempt == policy.Attempts || delay > policy.MaxInlineDelay {
			return nil, last
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	return nil, last
}

func retryDelay(header http.Header, attempt int) time.Duration {
	if raw := strings.TrimSpace(header.Get("Retry-After")); raw != "" {
		if seconds, err := strconv.Atoi(raw); err == nil && seconds >= 0 {
			return time.Duration(seconds) * time.Second
		}
		if at, err := http.ParseTime(raw); err == nil {
			return maxDuration(time.Until(at), time.Second)
		}
	}
	if raw := strings.TrimSpace(header.Get("X-RateLimit-Reset")); raw != "" {
		if unix, err := strconv.ParseInt(raw, 10, 64); err == nil {
			return maxDuration(time.Until(time.Unix(unix, 0)), time.Second)
		}
	}
	base := time.Second * time.Duration(1<<min(attempt-1, 5))
	return base + time.Duration(rand.Int63n(int64(base/4+1)))
}
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
func maxDuration(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
}
