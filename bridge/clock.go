package main

// Decoder clock -> wall clock (Unix ms on this laptop).
// Lap times must keep the decoder's own precision, so we do NOT stamp passings with the moment the
// bytes arrived (network/serial delay jitters by a few ms). Instead: wall = decoderMs + offset, where
// offset is learned from arrivals. A message can only arrive AFTER it happened, so the smallest
// (arrival - decoderMs) seen is the best estimate; the offset only tightens downwards.
// A large jump (decoder restarted or its clock was set) re-learns the offset.

type ClockMap struct {
	offset  int64
	ok      bool
	strikes int
}

const clockResetMs = 60_000

// Wall maps a decoder time to wall-clock ms, given when the message arrived (wall-clock ms).
func (c *ClockMap) Wall(decoderMs, arrivedMs int64) int64 {
	d := arrivedMs - decoderMs
	switch {
	case !c.ok:
		c.offset, c.ok = d, true
	case d < c.offset-clockResetMs:
		// decoder clock jumped forward (e.g. clock set): re-learn
		c.offset = d
		c.strikes = 0
	case d < c.offset:
		c.offset = d
		c.strikes = 0
	case d > c.offset+clockResetMs:
		// a passing that looks a minute+ old: either a resent old passing (keep the offset)
		// or the decoder restarted. Three in a row = restart.
		c.strikes++
		if c.strikes >= 3 {
			c.offset = d
			c.strikes = 0
		}
	default:
		c.strikes = 0
	}
	return decoderMs + c.offset
}
