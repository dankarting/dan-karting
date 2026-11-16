package main

// Decoder stream parsing. The bridge does not know in advance which format the decoder speaks,
// so one parser accepts all three and picks per message:
//
//   AMB P3 (binary, AMB rc3 / MYLAPS RC4 / ProChip, usually TCP port 5403):
//     0x8E | version | length(2 LE) | crc(2) | flags(2) | TOR(2 LE) | TLV fields ... | 0x8F
//     Bytes 0x8D..0x8F inside a message are escaped as 0x8D, byte+0x20.
//     TOR 0x0001 = PASSING. Fields: 0x01 passing number (u32), 0x03 transponder (u32),
//     0x04 RTC time (u64, microseconds), 0x05 strength (u16), 0x06 hits (u16),
//     0x0A transponder code (string), 0x10 UTC time (u64 us), 0x81 decoder id (u32).
//
//   AMB RC2 / AMBrc (ASCII over RS-232), one record per line:
//     $6900 111145 01855155 2D9C00     (no spaces on the wire)
//     "$" + 4 hex (record type / decoder) + 6 hex transponder + 8 hex decoder time + rest (hits/strength).
//     "#690F" lines are the once-a-second status heartbeat.
//     The transponder number printed on the transponder is the hex value in decimal (0x111145 = 1118533).
//     Time unit is believed to be milliseconds since the decoder was switched on; confirm on site with
//     `dk-bridge listen` (lap times must match a stopwatch). RC2TimeUnitMs scales it.
//
//   AMB legacy tab-separated ASCII (older TranX / AMBrc firmware), one record per line:
//     @ <tab> decoder <tab> passing# <tab> transponder <tab> seconds.mmm <tab> hits <tab> strength ...
//
// Everything unknown is kept as raw text/hex so a capture on site can be checked later.

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
)

// Passing is one crossing of the timing loop as the decoder reported it.
type Passing struct {
	Transponder string `json:"transponder"`
	DecoderMs   int64  `json:"decoder_t"` // decoder clock, ms
	PassingNo   int64  `json:"-"`
	DecoderID   string `json:"decoder"`
	Hits        int    `json:"hits"`
	Strength    int    `json:"strength"`
	Format      string `json:"-"`
	Raw         string `json:"-"`
}

// Parser turns raw decoder bytes into passings. Feed it whatever arrives; partial messages are kept.
type Parser struct {
	buf           []byte
	RC2TimeUnitMs float64
	OnStatus      func(format, raw string) // heartbeat / status messages (optional)
	OnUnknown     func(raw string)         // anything that did not parse (optional)
	Seen          string                   // last format seen: "p3", "rc2", "ascii"
}

func NewParser() *Parser { return &Parser{RC2TimeUnitMs: 1} }

const (
	p3SOR = 0x8E
	p3EOR = 0x8F
	p3ESC = 0x8D
)

// Feed appends data and returns every complete passing found.
func (p *Parser) Feed(data []byte) []Passing {
	p.buf = append(p.buf, data...)
	var out []Passing
	for len(p.buf) > 0 {
		b := p.buf[0]
		switch {
		case b == p3SOR:
			end := bytes.IndexByte(p.buf[1:], p3EOR)
			if end < 0 {
				if len(p.buf) > 4096 { // garbage that only looked like a start byte
					p.buf = p.buf[1:]
					continue
				}
				return out
			}
			frame := p.buf[:end+2]
			p.buf = p.buf[end+2:]
			if ps, ok := p.parseP3(frame); ok {
				out = append(out, ps...)
			}
		case b == '$' || b == '@' || b == '#':
			nl := bytes.IndexAny(p.buf, "\r\n")
			if nl < 0 {
				if len(p.buf) > 512 {
					p.buf = p.buf[1:]
					continue
				}
				return out
			}
			line := string(p.buf[:nl])
			p.buf = p.buf[nl+1:]
			if ps, ok := p.parseLine(line); ok {
				out = append(out, ps)
			}
		default:
			// skip line ends, spaces and noise between messages
			if b != '\r' && b != '\n' && b != ' ' && b != 0 && p.OnUnknown != nil {
				nl := 1
				for nl < len(p.buf) && !isBoundary(p.buf[nl]) {
					nl++
				}
				p.OnUnknown(printable(p.buf[:nl]))
				p.buf = p.buf[nl:]
				continue
			}
			p.buf = p.buf[1:]
		}
	}
	return out
}

func isBoundary(c byte) bool {
	return c == '\r' || c == '\n' || c == p3SOR || c == '$' || c == '@' || c == '#'
}

func printable(b []byte) string {
	for _, c := range b {
		if c < 0x20 || c > 0x7e {
			return "hex:" + hex.EncodeToString(b)
		}
	}
	return string(b)
}

// unescapeP3 removes the 0x8D escapes between the start and end bytes.
func unescapeP3(frame []byte) []byte {
	out := make([]byte, 0, len(frame))
	for i := 0; i < len(frame); i++ {
		c := frame[i]
		if c == p3ESC && i+1 < len(frame)-1 {
			i++
			out = append(out, frame[i]-0x20)
			continue
		}
		out = append(out, c)
	}
	return out
}

func (p *Parser) parseP3(frame []byte) ([]Passing, bool) {
	raw := hex.EncodeToString(frame)
	m := unescapeP3(frame)
	if len(m) < 11 {
		p.unknown("p3-short:" + raw)
		return nil, false
	}
	tor := binary.LittleEndian.Uint16(m[8:10])
	body := m[10 : len(m)-1]
	fields := map[byte][]byte{}
	for i := 0; i+2 <= len(body); {
		t, l := body[i], int(body[i+1])
		if i+2+l > len(body) {
			break
		}
		fields[t] = body[i+2 : i+2+l]
		i += 2 + l
	}
	p.Seen = "p3"
	if tor != 0x0001 {
		if p.OnStatus != nil {
			p.OnStatus("p3", fmt.Sprintf("TOR 0x%04x %s", tor, raw))
		}
		return nil, false
	}
	ps := Passing{Format: "p3", Raw: raw}
	if v, ok := fields[0x03]; ok {
		ps.Transponder = strconv.FormatUint(uintLE(v), 10)
	} else if v, ok := fields[0x0A]; ok {
		ps.Transponder = strings.TrimRight(string(v), "\x00")
	}
	if v, ok := fields[0x04]; ok {
		ps.DecoderMs = int64(uintLE(v) / 1000)
	} else if v, ok := fields[0x10]; ok {
		ps.DecoderMs = int64(uintLE(v) / 1000)
	}
	if v, ok := fields[0x01]; ok {
		ps.PassingNo = int64(uintLE(v))
	}
	if v, ok := fields[0x81]; ok {
		ps.DecoderID = fmt.Sprintf("%X", uintLE(v))
	}
	if v, ok := fields[0x05]; ok {
		ps.Strength = int(uintLE(v))
	}
	if v, ok := fields[0x06]; ok {
		ps.Hits = int(uintLE(v))
	}
	if ps.Transponder == "" || ps.DecoderMs == 0 {
		p.unknown("p3-passing-without-fields:" + raw)
		return nil, false
	}
	return []Passing{ps}, true
}

func uintLE(b []byte) uint64 {
	var v uint64
	for i := len(b) - 1; i >= 0; i-- {
		v = v<<8 | uint64(b[i])
	}
	return v
}

func (p *Parser) unknown(s string) {
	if p.OnUnknown != nil {
		p.OnUnknown(s)
	}
}

func isHex(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
			return false
		}
	}
	return true
}

func (p *Parser) parseLine(line string) (Passing, bool) {
	line = strings.TrimSpace(line)
	switch {
	case strings.HasPrefix(line, "#"):
		p.Seen = "rc2"
		if p.OnStatus != nil {
			p.OnStatus("rc2", line)
		}
		return Passing{}, false
	case strings.HasPrefix(line, "$"):
		s := strings.ReplaceAll(line[1:], " ", "")
		if len(s) < 18 || !isHex(s[:18]) {
			p.unknown("rc2?:" + line)
			return Passing{}, false
		}
		tx, _ := strconv.ParseUint(s[4:10], 16, 64)
		tm, _ := strconv.ParseUint(s[10:18], 16, 64)
		ps := Passing{Format: "rc2", Raw: line, DecoderID: s[:4], Transponder: strconv.FormatUint(tx, 10), DecoderMs: int64(float64(tm) * p.RC2TimeUnitMs)}
		p.Seen = "rc2"
		return ps, true
	case strings.HasPrefix(line, "@"):
		f := strings.FieldsFunc(line[1:], func(r rune) bool { return r == '\t' || r == ' ' })
		if len(f) < 4 {
			p.unknown("ascii?:" + line)
			return Passing{}, false
		}
		sec, err := strconv.ParseFloat(f[3], 64)
		if err != nil {
			p.unknown("ascii?:" + line)
			return Passing{}, false
		}
		ps := Passing{Format: "ascii", Raw: line, DecoderID: f[0], Transponder: f[2], DecoderMs: int64(sec * 1000)}
		if n, err := strconv.ParseInt(f[1], 10, 64); err == nil {
			ps.PassingNo = n
		}
		if len(f) > 4 {
			ps.Hits, _ = strconv.Atoi(f[4])
		}
		if len(f) > 5 {
			ps.Strength, _ = strconv.Atoi(f[5])
		}
		p.Seen = "ascii"
		return ps, true
	}
	return Passing{}, false
}

// ----------------------------------------------------------------- encoders (simulator / tests)

func escapeP3(m []byte) []byte {
	out := []byte{m[0]}
	for _, c := range m[1 : len(m)-1] {
		if c >= p3ESC && c <= p3EOR {
			out = append(out, p3ESC, c+0x20)
			continue
		}
		out = append(out, c)
	}
	return append(out, m[len(m)-1])
}

// EncodeP3Passing builds a P3 PASSING message (used by the fake decoder and the tests).
func EncodeP3Passing(passingNo uint32, transponder uint32, rtcMicros uint64, decoderID uint32) []byte {
	var body []byte
	add := func(t byte, v []byte) { body = append(body, t, byte(len(v))); body = append(body, v...) }
	u32 := func(x uint32) []byte { b := make([]byte, 4); binary.LittleEndian.PutUint32(b, x); return b }
	u16 := func(x uint16) []byte { b := make([]byte, 2); binary.LittleEndian.PutUint16(b, x); return b }
	u64 := make([]byte, 8)
	binary.LittleEndian.PutUint64(u64, rtcMicros)
	add(0x01, u32(passingNo))
	add(0x03, u32(transponder))
	add(0x04, u64)
	add(0x05, u16(120))
	add(0x06, u16(40))
	add(0x08, u16(0))
	add(0x81, u32(decoderID))
	m := []byte{p3SOR, 0x02, 0, 0, 0, 0, 0, 0, 0x01, 0x00}
	m = append(m, body...)
	m = append(m, p3EOR)
	binary.LittleEndian.PutUint16(m[2:4], uint16(len(m)))
	return escapeP3(m)
}

// EncodeRC2Passing builds an RC2 ASCII passing line.
func EncodeRC2Passing(transponder uint32, decoderMs uint32) string {
	return fmt.Sprintf("$6900%06X%08X2D9C00\r\n", transponder&0xFFFFFF, decoderMs)
}
