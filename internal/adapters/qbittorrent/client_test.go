package qbittorrent

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestInfoHashUsesExactInfoDictionary(t *testing.T) {
	torrent := []byte("d8:announce13:https://test/4:infod6:lengthi5e4:name9:video.mp412:piece lengthi4e6:pieces20:aaaaaaaaaaaaaaaaaaaaee")
	hash, err := infoHash(torrent)
	if err != nil {
		t.Fatal(err)
	}
	if hash != "52e0ec3afc6723a6be6a2dad955dc4027babc55c" {
		t.Fatalf("unexpected hash %s", hash)
	}
}

func TestInfoHashRejectsMissingInfo(t *testing.T) {
	if _, err := infoHash([]byte("d3:fooi1ee")); err == nil {
		t.Fatal("expected error")
	}
}

func TestPieceSizeComesFromTorrentProperties(t *testing.T) {
	responses := map[string]string{
		"/api/v2/auth/login":           "Ok.",
		"/api/v2/torrents/pieceStates": `[2,1,0]`,
		"/api/v2/torrents/properties":  `{"piece_size":2097152}`,
		"/api/v2/torrents/info":        `[{"hash":"abc","state":"downloading","total_size":100,"amount_left":40,"save_path":"/srv/downloads","content_path":"/srv/downloads/movie.mkv"}]`,
		"/api/v2/torrents/trackers":    `[]`,
	}
	client := New(func() (string, string, string) { return "http://qb.test", "user", "password" })
	client.http.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		body, ok := responses[r.URL.Path]
		if !ok {
			body = `{}`
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})
	pieces, err := client.Pieces(t.Context(), "abc")
	if err != nil {
		t.Fatal(err)
	}
	if pieces.PieceSize != 2097152 || len(pieces.States) != 3 {
		t.Fatalf("unexpected pieces: %+v", pieces)
	}

	status, err := client.Status(t.Context(), "abc")
	if err != nil {
		t.Fatal(err)
	}
	if status.PieceSize != 2097152 || status.SavePath != "/srv/downloads" {
		t.Fatalf("unexpected status: %+v", status)
	}
}

func TestAddResponseCompatibility(t *testing.T) {
	for _, tt := range []struct {
		status int
		body   string
		want   bool
	}{
		{http.StatusOK, "", true},
		{http.StatusOK, "Ok.", true},
		{http.StatusOK, "Fails.", false},
		{http.StatusInternalServerError, "", false},
	} {
		if got := addAccepted(tt.status, []byte(tt.body)); got != tt.want {
			t.Errorf("addAccepted(%d, %q) = %v, want %v", tt.status, tt.body, got, tt.want)
		}
	}
}

func TestAddReusesExistingTorrentAfterDuplicateResponse(t *testing.T) {
	torrent := []byte("d8:announce13:https://test/4:infod6:lengthi5e4:name9:video.mp412:piece lengthi4e6:pieces20:aaaaaaaaaaaaaaaaaaaaee")
	client := New(func() (string, string, string) { return "http://qb.test", "user", "password" })
	client.http.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		body := "{}"
		switch r.URL.Path {
		case "/api/v2/auth/login":
			body = "Ok."
		case "/api/v2/torrents/add":
			body = "Fails."
		case "/api/v2/torrents/info":
			body = `[{"hash":"52e0ec3afc6723a6be6a2dad955dc4027babc55c","state":"uploading","total_size":5,"amount_left":0,"save_path":"/srv/downloads"}]`
		case "/api/v2/torrents/properties":
			body = `{"piece_size":4}`
		case "/api/v2/torrents/trackers":
			body = `[]`
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})

	hash, err := client.Add(t.Context(), strings.NewReader(string(torrent)), "/srv/downloads")
	if err != nil {
		t.Fatal(err)
	}
	if hash != "52e0ec3afc6723a6be6a2dad955dc4027babc55c" {
		t.Fatalf("unexpected hash %q", hash)
	}
}
