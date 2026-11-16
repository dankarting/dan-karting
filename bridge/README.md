# dk-bridge

AMB decoder -> Supabase bridge for the Dan Karting app. Owner instructions (Hebrew): `../docs/BRIDGE-HE.md`.

    go test ./...
    GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o dk-bridge.exe .

Ship `dk-bridge.exe` with the files in `windows/`. `bridge.json` is created next to the exe on first run.
End-to-end test without hardware: `dk-bridge fake-decoder -format rc2` in one window,
`dk-bridge listen -host 127.0.0.1 -port 5403` in another.
