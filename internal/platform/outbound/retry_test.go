package outbound

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestDoRetriesExplicitRateLimit(t *testing.T) {
	var calls atomic.Int32
	client := &http.Client{Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
		status := http.StatusNoContent
		header := make(http.Header)
		if calls.Add(1) == 1 {
			status = http.StatusTooManyRequests
			header.Set("Retry-After", "0")
		}
		return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	response, err := Do(context.Background(), client, func() (*http.Request, error) {
		return http.NewRequest(http.MethodGet, "http://provider.test", nil)
	}, Policy{Provider: "test", Attempts: 3, MaxInlineDelay: time.Second})
	if err != nil || response.StatusCode != http.StatusNoContent || calls.Load() != 2 {
		t.Fatalf("response=%v calls=%d err=%v", response, calls.Load(), err)
	}
	response.Body.Close()
}

func TestDoDefersLongRateLimitToJobScheduler(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
		header := make(http.Header)
		header.Set("Retry-After", strconv.Itoa(60))
		return &http.Response{StatusCode: http.StatusTooManyRequests, Header: header, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	_, err := Do(context.Background(), client, func() (*http.Request, error) {
		return http.NewRequest(http.MethodGet, "http://provider.test", nil)
	}, Policy{Provider: "test", Attempts: 3, MaxInlineDelay: time.Second})
	var limited *RateLimitError
	if !errors.As(err, &limited) || limited.Provider != "test" || limited.Attempts != 1 || time.Until(limited.RetryAt) < 55*time.Second {
		t.Fatalf("expected deferred rate limit, got %#v (%v)", limited, err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }
