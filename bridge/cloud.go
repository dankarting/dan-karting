package main

// Supabase upload: signs in as a staff user (same accounts as the ?staff app), inserts passings into
// public.passings and keeps a heartbeat row in public.decoder_status. Offline-safe: passings wait in a
// queue and are retried; the local CSV log is written first, so nothing is lost if the internet drops.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

type Row struct {
	UID         string `json:"uid"`
	Transponder string `json:"transponder"`
	T           int64  `json:"t"`
	DecoderT    int64  `json:"decoder_t"`
	Decoder     string `json:"decoder"`
	Hits        int    `json:"hits"`
	Strength    int    `json:"strength"`
}

type Cloud struct {
	URL, Key, Email, Password string

	mu      sync.Mutex
	token   string
	refresh string
	expires time.Time
	queue   []Row
	client  *http.Client
	LastErr string
	Sent    int
}

func NewCloud(url, key, user, password string) *Cloud {
	email := strings.ToLower(strings.TrimSpace(user))
	if !strings.Contains(email, "@") {
		email += "@dankarting.app"
	}
	return &Cloud{URL: strings.TrimRight(url, "/"), Key: key, Email: email, Password: password, client: &http.Client{Timeout: 15 * time.Second}}
}

func (c *Cloud) do(method, path string, body any, auth bool, prefer string) ([]byte, error) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.URL+path, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("apikey", c.Key)
	req.Header.Set("Content-Type", "application/json")
	if prefer != "" {
		req.Header.Set("Prefer", prefer)
	}
	if auth {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	res, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 300 {
		return out, fmt.Errorf("HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(out)))
	}
	return out, nil
}

// SignIn gets (or refreshes) the staff access token.
func (c *Cloud) SignIn() error {
	if c.token != "" && time.Until(c.expires) > 2*time.Minute {
		return nil
	}
	var body any
	path := "/auth/v1/token?grant_type=password"
	if c.refresh != "" {
		path = "/auth/v1/token?grant_type=refresh_token"
		body = map[string]string{"refresh_token": c.refresh}
	} else {
		body = map[string]string{"email": c.Email, "password": c.Password}
	}
	out, err := c.do("POST", path, body, false, "")
	if err != nil && c.refresh != "" { // refresh token expired: full sign-in
		c.refresh = ""
		return c.SignIn()
	}
	if err != nil {
		return fmt.Errorf("sign-in failed for %s: %w", c.Email, err)
	}
	var r struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if err := json.Unmarshal(out, &r); err != nil || r.AccessToken == "" {
		return fmt.Errorf("unexpected sign-in reply")
	}
	c.token, c.refresh = r.AccessToken, r.RefreshToken
	c.expires = time.Now().Add(time.Duration(r.ExpiresIn) * time.Second)
	return nil
}

func (c *Cloud) Enqueue(r Row) {
	c.mu.Lock()
	c.queue = append(c.queue, r)
	c.mu.Unlock()
}

func (c *Cloud) Pending() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.queue)
}

// Flush sends everything queued. Duplicates (same uid) are ignored by the database.
func (c *Cloud) Flush() error {
	c.mu.Lock()
	batch := append([]Row(nil), c.queue...)
	c.mu.Unlock()
	if len(batch) == 0 {
		return nil
	}
	if err := c.SignIn(); err != nil {
		c.LastErr = err.Error()
		return err
	}
	if _, err := c.do("POST", "/rest/v1/passings?on_conflict=uid", batch, true, "resolution=ignore-duplicates,return=minimal"); err != nil {
		c.LastErr = err.Error()
		return err
	}
	c.mu.Lock()
	c.queue = c.queue[len(batch):]
	c.Sent += len(batch)
	c.mu.Unlock()
	c.LastErr = ""
	return nil
}

// Status upserts the heartbeat row the app shows in Settings (bridge connected).
func (c *Cloud) Status(data map[string]any) error {
	if err := c.SignIn(); err != nil {
		return err
	}
	row := map[string]any{"id": "main", "data": data, "updated_at": time.Now().UTC().Format(time.RFC3339Nano)}
	_, err := c.do("POST", "/rest/v1/decoder_status?on_conflict=id", row, true, "resolution=merge-duplicates,return=minimal")
	return err
}
