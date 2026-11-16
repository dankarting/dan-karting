# dk-bridge

The one timing bridge for the Dan Karting app. Owner instructions (Hebrew): `../docs/BRIDGE-HE.md`.

It serves `http://localhost:8787` in the same JSON format as `public/rentix-bridge.ps1`
(`{connected, error, at, source, lines}`), so the app has a single timing path (`src/rentix.ts`):

- `source: "rentix"`: RentiX's RMonitor feed (TCP 50000) passed through, read-only. Tried first.
- `source: "decoder"`: the AMB decoder read directly (P3 binary, RC2 ASCII, legacy `@` text; serial or TCP)
  when no RentiX answers. Passings are grouped into heats and rendered as RMonitor records here;
  the app maps transponder -> kart (Settings -> שעון הקפות).

dk-bridge replaces rentix-bridge.ps1. Don't run both: they share localhost:8787.

    go test ./...
    GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o dk-bridge.exe .

Ship `dk-bridge.exe` with the files in `windows/`. `bridge.json` is created next to the exe on first run.
Tests without hardware: `dk-bridge fake-rentix` or `dk-bridge fake-decoder -format rc2|p3` in one window,
`dk-bridge run` in another, then `curl localhost:8787`. `dk-bridge sim` serves a simulated decoder heat.
