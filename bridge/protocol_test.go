package main

import "testing"

func TestP3RoundTrip(t *testing.T) {
	// transponder and time chosen so escaping is needed (bytes 0x8D..0x8F inside)
	msg := EncodeP3Passing(7, 0x8E8F8D, 1_700_000_000_123_456, 0x0A1B2C)
	p := NewParser()
	// feed in two halves, with noise in front
	ps := p.Feed(append([]byte{0x00, 0x0d}, msg[:9]...))
	ps = append(ps, p.Feed(msg[9:])...)
	if len(ps) != 1 {
		t.Fatalf("want 1 passing, got %d", len(ps))
	}
	if ps[0].Transponder != "9342861" || ps[0].DecoderMs != 1_700_000_000_123 || ps[0].PassingNo != 7 || ps[0].DecoderID != "A1B2C" {
		t.Fatalf("bad passing %+v", ps[0])
	}
}

func TestRC2Lines(t *testing.T) {
	p := NewParser()
	// examples published by an AMB RC2 owner
	ps := p.Feed([]byte("#690F\r\n$6900111145018551552D9C00\r\n$6900039E0601856BD52D9900\r\n"))
	if len(ps) != 2 {
		t.Fatalf("want 2, got %d", len(ps))
	}
	if ps[0].Transponder != "1118533" || ps[0].DecoderMs != 0x01855155 {
		t.Fatalf("bad %+v", ps[0])
	}
	if ps[1].Transponder != "237062" || ps[1].DecoderMs-ps[0].DecoderMs != 6784 {
		t.Fatalf("bad %+v", ps[1])
	}
	if p.Seen != "rc2" {
		t.Fatal("format not detected")
	}
	enc := EncodeRC2Passing(1118533, 0x01855155)
	q := NewParser().Feed([]byte(enc))
	if len(q) != 1 || q[0].Transponder != "1118533" {
		t.Fatalf("encode mismatch %q", enc)
	}
}

func TestLegacyASCII(t *testing.T) {
	ps := NewParser().Feed([]byte("@\t01\t153\t4512345\t1234.567\t35\t120\r\n"))
	if len(ps) != 1 || ps[0].Transponder != "4512345" || ps[0].DecoderMs != 1234567 || ps[0].PassingNo != 153 {
		t.Fatalf("bad %+v", ps)
	}
}

func TestClockMap(t *testing.T) {
	c := &ClockMap{}
	// decoder time 1000 arrives at wall 50_020 (20 ms delay)
	if w := c.Wall(1000, 50_020); w != 50_020 {
		t.Fatal(w)
	}
	// next arrives with only 5 ms delay: offset tightens
	if w := c.Wall(2000, 51_005); w != 51_005 {
		t.Fatal(w)
	}
	// a slow arrival keeps decoder precision
	if w := c.Wall(3000, 52_090); w != 52_005 {
		t.Fatal(w)
	}
	// decoder restart (clock back to 0): three in a row re-learn
	c.Wall(10, 200_000)
	c.Wall(20, 200_010)
	if w := c.Wall(30, 200_020); w != 200_020 {
		t.Fatal(w)
	}
}
