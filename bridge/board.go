package main

// What the staff page reads. The bridge serves ONE local endpoint, http://localhost:8787, in the same format
// as the earlier rentix-bridge.ps1: { connected, error, at, source, lines: [RMonitor records] }.
// The app's existing RentiX code (src/rentix.ts) turns the lines into the live board. So there is a single
// timing path in the app, whatever the source:
//   source "rentix":  RentiX's own scoreboard feed (RMonitor, TCP 50000) passed through as is (read-only).
//   source "decoder": the AMB decoder read directly; passings are turned into RMonitor records here.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"
)

type Board struct {
	mu        sync.Mutex
	connected bool
	err       string
	at        int64
	source    string
	// rentix pass-through: latest record per key (in first-seen order) + every $J
	keys     []string
	records  map[string]string
	passings []string
	// decoder: one heat at a time
	dec *DecoderHeat
}

func NewBoard() *Board { return &Board{records: map[string]string{}} }

func (b *Board) SetConn(connected bool, source, err string) {
	b.mu.Lock()
	b.connected, b.err = connected, err
	if source != "" {
		b.source = source
	}
	b.mu.Unlock()
}

var reKeyed = regexp.MustCompile(`^\$(A|COMP|G|H),"?([^",]*)"?,"?([^",]*)"?`)
var reType = regexp.MustCompile(`^\$([A-Z]+)`)

// decodeText: RentiX may send UTF-8 or Windows Hebrew (1255).
func decodeText(raw []byte) string {
	if utf8.Valid(raw) {
		return string(raw)
	}
	s, err := charmap.Windows1255.NewDecoder().Bytes(raw)
	if err != nil {
		return string(raw)
	}
	return string(s)
}

// AddRMonitor stores one RentiX line (same rules as rentix-bridge.ps1).
func (b *Board) AddRMonitor(line string) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "$") {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.at = time.Now().UnixMilli()
	set := func(k, v string) {
		if _, ok := b.records[k]; !ok {
			b.keys = append(b.keys, k)
		}
		b.records[k] = v
	}
	switch {
	case line == "$I" || strings.HasPrefix(line, "$I,"):
		b.keys, b.records, b.passings = nil, map[string]string{}, nil
		set("I", line)
	case strings.HasPrefix(line, "$J,"):
		b.passings = append(b.passings, line)
		if len(b.passings) > 4000 {
			b.passings = b.passings[1:]
		}
	default:
		if m := reKeyed.FindStringSubmatch(line); m != nil {
			if m[1] == "G" || m[1] == "H" {
				set(m[1]+":"+m[3], line)
			} else {
				set("C:"+m[2], line)
			}
		} else if m := reType.FindStringSubmatch(line); m != nil {
			set(m[1], line)
		}
	}
}

// ------------------------------------------------------------------ decoder -> RMonitor

// DecoderHeat groups passings into heats: a heat starts with the first crossing after the track was quiet
// for GapMs, and is shown as finished once it is quiet again. The first crossing of each kart starts its clock.
type DecoderHeat struct {
	GapMs, MinLapMs int64
	num             int
	start, last     int64
	karts           map[string][]int64 // transponder -> crossing times
	order           []string
}

func (h *DecoderHeat) Add(tx string, t int64) {
	if h.karts == nil || t-h.last > h.GapMs {
		h.num++
		h.start, h.karts, h.order = t, map[string][]int64{}, nil
	}
	if t > h.last {
		h.last = t
	}
	ts, seen := h.karts[tx]
	if !seen {
		h.order = append(h.order, tx)
	}
	if len(ts) > 0 && t-ts[len(ts)-1] < h.MinLapMs {
		return // double read
	}
	h.karts[tx] = append(ts, t)
}

func clockStr(ms int64) string {
	if ms < 0 {
		ms = 0
	}
	return fmt.Sprintf("%02d:%02d:%02d.%03d", ms/3_600_000, ms/60_000%60, ms/1000%60, ms%1000)
}

// Lines renders the heat as RMonitor records for the app.
func (h *DecoderHeat) Lines(now int64) []string {
	if h == nil || h.karts == nil {
		return nil
	}
	type row struct {
		tx         string
		laps       []int64
		lastT      int64
		best, totl int64
	}
	var rows []row
	for _, tx := range h.order {
		ts := h.karts[tx]
		r := row{tx: tx, lastT: ts[len(ts)-1], totl: ts[len(ts)-1] - h.start}
		for i := 1; i < len(ts); i++ {
			lap := ts[i] - ts[i-1]
			r.laps = append(r.laps, lap)
			if r.best == 0 || lap < r.best {
				r.best = lap
			}
		}
		rows = append(rows, r)
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if len(rows[i].laps) != len(rows[j].laps) {
			return len(rows[i].laps) > len(rows[j].laps)
		}
		return rows[i].lastT < rows[j].lastT
	})
	flag := "Green"
	if now-h.last > h.GapMs {
		flag = "Finish"
	}
	out := []string{
		fmt.Sprintf(`$I,"%s","decoder"`, clockStr(h.start%86_400_000)),
		fmt.Sprintf(`$B,%d,"מקצה %d · דקודר"`, h.num, h.num),
		fmt.Sprintf(`$F,"","00:00:00","%s","%s","%s"`, time.UnixMilli(now).Format("15:04:05"), clockStr(min64(now, h.last+h.GapMs)-h.start), flag),
	}
	for _, r := range rows {
		// number field empty: the app maps transponder -> kart (Settings)
		out = append(out, fmt.Sprintf(`$A,"%s","",%s,"","","",""`, r.tx, r.tx))
	}
	for i, r := range rows {
		out = append(out, fmt.Sprintf(`$G,%d,"%s",%d,"%s"`, i+1, r.tx, len(r.laps), clockStr(r.totl)))
		if r.best > 0 {
			out = append(out, fmt.Sprintf(`$H,%d,"%s",0,"%s"`, i+1, r.tx, clockStr(r.best)))
		}
	}
	for _, r := range rows {
		ts := h.karts[r.tx]
		for i := 1; i < len(ts); i++ {
			out = append(out, fmt.Sprintf(`$J,"%s","%s","%s"`, r.tx, clockStr(ts[i]-ts[i-1]), clockStr(ts[i]-h.start)))
		}
	}
	return out
}

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

func (b *Board) AddPassing(tx string, t int64, gapMs, minLapMs int64) {
	b.mu.Lock()
	if b.dec == nil {
		b.dec = &DecoderHeat{GapMs: gapMs, MinLapMs: minLapMs}
	}
	b.dec.Add(tx, t)
	b.at = time.Now().UnixMilli()
	b.mu.Unlock()
}

func (b *Board) Snapshot() map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	var lines []string
	if b.source == "decoder" {
		lines = b.dec.Lines(time.Now().UnixMilli())
	} else {
		for _, k := range b.keys {
			lines = append(lines, b.records[k])
		}
		lines = append(lines, b.passings...)
	}
	if lines == nil {
		lines = []string{}
	}
	return map[string]any{"connected": b.connected, "error": b.err, "at": b.at, "source": b.source, "lines": lines}
}

// Serve answers the staff page on this computer only (http://localhost:<port>).
func (b *Board) Serve(port int) error {
	return http.ListenAndServe(fmt.Sprintf("127.0.0.1:%d", port), b.handler())
}

func (b *Board) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "*")
		w.Header().Set("Cache-Control", "no-store")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(b.Snapshot())
	})
}

// Serve6 is the same on IPv6 localhost (browsers may try ::1 first for "localhost").
func (b *Board) Serve6(port int) error {
	return http.ListenAndServe(fmt.Sprintf("[::1]:%d", port), b.handler())
}
