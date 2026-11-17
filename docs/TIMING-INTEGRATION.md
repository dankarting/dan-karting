# Timing integration - what a real decoder input needs (design only)

Update: live timing now comes from bridge/ (dk-bridge) via localhost:8787, see docs/BRIDGE-HE.md.
The notes below are the original design notes.

Status (original): the demo is fully SIMULATED. No hardware has been accessed, nothing is connected,
no vendor has been contacted. This page records the seam and the open questions.

## Target
This app is meant to replace the venue's current timing software and read the venue's own
lap-timing hardware directly (read-only). Owner-reported hardware: an AMBrc2 decoder,
connected over RS-232 through a USB adapter. Not verified on site.

## The seam (already in src/logic.ts, tested)
    decoder adapter (future)  ->  Passing[]  ->  lapsFromPassings()  ->  DriverTiming[]  ->  boards, results
- `Passing = { transponder: string; t: number }` - "this transponder crossed the line at time t (ms)".
- `lapsFromPassings(drivers, passings, startT, totalLaps, tx, rules)` - pure; sorts, ignores crossings
  before the start, drops double reads closer than `rules.minLapMs`, stops at `totalLaps`.
- `rules.firstCrossing`: 'lap' (karts start behind the line) or 'start' (rolling start). Not decided.
- `transponderOf(core)` - kart number -> transponder id (`settings.transponders`); default synthetic `SIM-<kart>`.
- `unknownTransponders()` - crossings that match no driver in the heat, for the operator to resolve.
- `makePassingFeed(read, startT)` - the TimingFeed shape a decoder-backed feed would use. The demo's
  `makeSimulatedFeed` already goes through the same `lapsFromPassings` path.

## What a real integration still needs (open)
1. **Protocol**: the AMBrc2 serial message format, baud rate and framing are NOT assumed here.
   They must come from the decoder's own documentation or a capture on site, with permission.
2. **Bridge**: a web page cannot open a serial port in every browser. Options to evaluate later:
   a small local bridge program on the venue PC (serial in, passings out to the app), or the
   browser Web Serial API (Chromium-based browsers only, needs user permission). Not chosen.
3. **Clock**: decoder time vs app time. The race start (`startT`) must be on the decoder clock,
   or the offset measured. Who triggers the start (operator button vs first crossing) is open.
4. **Transponder mapping**: are transponders fixed to karts? Where is the list kept? Swaps?
5. **Sectors**: the live board shows S1/S2/S3, but these are SIMULATED. Real sectors need extra
   timing loops on the track; a single start/finish loop gives lap times only. Unknown for this track.
6. **Noise**: minimum lap time, pit lane crossings, missed reads (a lost passing merges two laps).
7. **Cut-over**: run in parallel with the current system first (read-only), compare lap times
   heat by heat, and switch only after the venue agrees. No switchover is part of this demo.
8. **Persistence**: as the system of record it needs a shared backend; today data is device-local.
