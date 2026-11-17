package main

import (
	"strings"
	"testing"
)

func TestRMonitorStore(t *testing.T) {
	b := NewBoard()
	b.SetConn(true, "rentix", "")
	for _, l := range []string{`$A,"1","1",1000001,"A","B","",1`, `$G,1,"1",1,"00:00:41.000"`, `$J,"1","00:00:41.000","00:00:41.000"`, `$G,1,"1",2,"00:01:21.000"`, `$J,"1","00:00:40.000","00:01:21.000"`} {
		b.AddRMonitor(l)
	}
	lines := b.Snapshot()["lines"].([]string)
	if len(lines) != 4 || lines[1] != `$G,1,"1",2,"00:01:21.000"` {
		t.Fatalf("%q", lines)
	}
	b.AddRMonitor(`$I,"12:00","x"`)
	if l := b.Snapshot()["lines"].([]string); len(l) != 1 {
		t.Fatalf("reset: %q", l)
	}
}

func TestDecoderHeat(t *testing.T) {
	h := &DecoderHeat{GapMs: 60_000, MinLapMs: 15_000}
	h.Add("111", 1_000_000)
	h.Add("222", 1_002_000)
	h.Add("111", 1_041_000)
	h.Add("111", 1_041_300) // double read
	h.Add("111", 1_080_000)
	h.Add("222", 1_045_000)
	s := strings.Join(h.Lines(1_081_000), "\n")
	for _, want := range []string{`$B,1,"מקצה 1 · דקודר"`, `$G,1,"111",2,"00:01:20.000"`, `$H,1,"111",0,"00:00:39.000"`, `$J,"111","00:00:41.000","00:00:41.000"`, `"Green"`} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %s in\n%s", want, s)
		}
	}
	if !strings.Contains(strings.Join(h.Lines(1_200_000), "\n"), `"Finish"`) {
		t.Fatal("quiet track should finish the heat")
	}
	h.Add("333", 1_300_000) // after a quiet gap: a new heat
	if s := strings.Join(h.Lines(1_300_500), "\n"); !strings.Contains(s, `$B,2,`) || strings.Contains(s, `"111"`) {
		t.Fatalf("new heat expected:\n%s", s)
	}
}
