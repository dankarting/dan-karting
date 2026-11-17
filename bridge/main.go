// dk-bridge: brings live lap timing from the track to the Dan Karting app. Runs on the staff laptop (Windows).
// It reads RentiX's scoreboard feed (read-only), or, when no RentiX is running, the AMB decoder directly, and
// serves the result to the staff page on this computer at http://localhost:8787. See docs/BRIDGE-HE.md.
//
//	dk-bridge install      once: start by itself with Windows + desktop icon, then run
//	dk-bridge              run: finds RentiX or the decoder by itself, remembers it, serves the live board
//	dk-bridge listen       show what arrives, nothing else (first test on site)
//	dk-bridge ports        list COM ports
//	dk-bridge find         look for RentiX (50000) / a network decoder (5403, 5100) on this network
//	dk-bridge sim          no hardware: a simulated decoder heat on the staff page
//	dk-bridge fake-decoder / fake-rentix   pretend to be a decoder / RentiX on TCP (testing)
//	dk-bridge uninstall    stop starting with Windows
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/rand"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.bug.st/serial"
)

const version = "2.0.0"

type Config struct {
	Source        string  `json:"source"` // auto (RentiX first, then the decoder) | rentix | decoder
	RentixHost    string  `json:"rentix_host"`
	RentixPort    int     `json:"rentix_port"`
	Connection    string  `json:"connection"` // decoder: auto | serial | tcp
	ComPort       string  `json:"com_port"`   // decoder: auto | COM3 ...
	Baud          int     `json:"baud"`       // decoder: 0 = try common speeds
	DecoderHost   string  `json:"decoder_host"`
	DecoderPort   int     `json:"decoder_port"`
	RC2TimeUnitMs float64 `json:"rc2_time_unit_ms"`
	MinLapSec     float64 `json:"min_lap_sec"`  // decoder: crossings closer than this are double reads
	HeatGapSec    float64 `json:"heat_gap_sec"` // decoder: this long without crossings = the heat is over
	LocalPort     int     `json:"local_port"`   // the staff page reads http://localhost:<port>
	RelayPort     int     `json:"relay_port"`   // decoder: >0 re-serves the raw stream on 127.0.0.1:<port>
}

func defaults() Config {
	return Config{
		Source: "auto", RentixHost: "192.168.0.1", RentixPort: 50000,
		Connection: "auto", ComPort: "auto", Baud: 0, DecoderPort: 5403,
		RC2TimeUnitMs: 1, MinLapSec: 15, HeatGapSec: 60, LocalPort: 8787,
	}
}

func exeDir() string {
	if e, err := os.Executable(); err == nil {
		return filepath.Dir(e)
	}
	return "."
}

func configPath() string { return filepath.Join(exeDir(), "bridge.json") }

func loadConfig() Config {
	c := defaults()
	b, err := os.ReadFile(configPath())
	if err != nil {
		saveConfig(c)
		return c
	}
	if err := json.Unmarshal(b, &c); err != nil {
		fmt.Println("!! bridge.json has an error:", err)
		os.Exit(1)
	}
	return c
}

func saveConfig(c Config) {
	b, _ := json.MarshalIndent(c, "", "  ")
	_ = os.WriteFile(configPath(), b, 0o600)
}

func main() {
	cmd := "run"
	args := os.Args[1:]
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	cfg := loadConfig()
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	fs.StringVar(&cfg.Source, "source", cfg.Source, "auto | rentix | decoder")
	fs.StringVar(&cfg.RentixHost, "rentix", cfg.RentixHost, "RentiX computer address")
	fs.IntVar(&cfg.RentixPort, "rentix-port", cfg.RentixPort, "RentiX RMonitor port")
	fs.StringVar(&cfg.DecoderHost, "host", cfg.DecoderHost, "decoder IP (network decoder)")
	fs.IntVar(&cfg.DecoderPort, "port", cfg.DecoderPort, "decoder TCP port")
	fs.StringVar(&cfg.ComPort, "com", cfg.ComPort, "decoder COM port, or auto")
	fs.IntVar(&cfg.Baud, "baud", cfg.Baud, "decoder serial speed, 0 = auto")
	fs.IntVar(&cfg.LocalPort, "local", cfg.LocalPort, "local port for the staff page")
	karts := fs.Int("karts", 8, "sim/fake: number of karts")
	first := fs.Int("first", 1000001, "sim/fake: first transponder number")
	speed := fs.Float64("speed", 1, "sim/fake: time speed-up")
	format := fs.String("format", "p3", "fake-decoder: p3 | rc2")
	listenPort := fs.Int("listen", 0, "fake-*: TCP port to serve")
	_ = fs.Parse(args)

	fmt.Printf("Dan Karting timing bridge %s\n", version)
	switch cmd {
	case "run":
		run(cfg, false)
	case "listen":
		run(cfg, true)
	case "install":
		install(cfg)
	case "uninstall":
		uninstall()
	case "ports":
		listPorts()
	case "find":
		find(cfg)
	case "sim":
		sim(cfg, *karts, uint32(*first), *speed)
	case "fake-decoder":
		fakeDecoder(orDefault(*listenPort, 5403), *format, *karts, uint32(*first), *speed)
	case "fake-rentix":
		fakeRentix(orDefault(*listenPort, 50000), *karts, *speed)
	default:
		fmt.Println("Unknown command:", cmd, "\nUse: install | run | listen | ports | find | sim | uninstall")
		os.Exit(2)
	}
}

func orDefault(v, d int) int {
	if v > 0 {
		return v
	}
	return d
}

var bauds = []int{9600, 19200, 38400, 57600, 115200}

// serveBoard starts the local endpoint the staff page reads (IPv4 and IPv6 localhost).
func serveBoard(b *Board, port int) {
	go func() {
		if err := b.Serve(port); err != nil {
			fmt.Printf("!!  cannot open http://localhost:%d (%v). Is another bridge (e.g. rentix-bridge.ps1) already running? Close it.\n", port, err)
			os.Exit(1)
		}
	}()
	go func() { _ = b.Serve6(port) }()
	fmt.Printf("OK  staff page link: http://localhost:%d (open the staff page on THIS computer)\n", port)
}

func run(cfg Config, verbose bool) {
	board := NewBoard()
	logDir := filepath.Join(exeDir(), "logs")
	_ = os.MkdirAll(logDir, 0o755)
	var capture *os.File
	if verbose {
		capture, _ = os.Create(filepath.Join(logDir, "capture-"+time.Now().Format("20060102-150405")+".txt"))
		if capture != nil {
			fmt.Println("    raw capture:", capture.Name())
		}
	} else {
		serveBoard(board, cfg.LocalPort)
	}
	relay := startRelay(cfg.RelayPort)
	clock := &ClockMap{}
	lastBy := map[string]int64{}
	count := 0
	for {
		c, err := connect(&cfg)
		if err != nil {
			board.SetConn(false, "", err.Error())
			fmt.Println("!! ", err, "- trying again in 5 s")
			time.Sleep(5 * time.Second)
			continue
		}
		fmt.Println("OK  connected:", c.desc)
		fmt.Println("    Ready. Keep this window open.")
		board.SetConn(true, c.kind, "")
		if c.kind == "rentix" {
			sc := bufio.NewScanner(c.src)
			sc.Buffer(make([]byte, 64*1024), 1024*1024)
			sc.Split(scanCRLF)
			n := 0
			for sc.Scan() {
				line := decodeText(sc.Bytes())
				if capture != nil {
					fmt.Fprintf(capture, "%s %s\n", time.Now().Format("15:04:05.000"), line)
				}
				if verbose {
					fmt.Println("   ", line)
				}
				board.AddRMonitor(line)
				if n++; n == 1 {
					fmt.Println("OK  receiving RentiX live timing")
				}
			}
			fmt.Println("!!  RentiX connection closed:", sc.Err())
		} else {
			readDecoder(c, &cfg, verbose, capture, relay, clock, board, lastBy, &count)
		}
		c.src.Close()
		board.SetConn(false, "", "connection lost")
		time.Sleep(2 * time.Second)
	}
}

// scanCRLF splits on \r, \n or \r\n.
func scanCRLF(data []byte, atEOF bool) (int, []byte, error) {
	for i, b := range data {
		if b == '\r' || b == '\n' {
			j := i + 1
			if b == '\r' && j < len(data) && data[j] == '\n' {
				j++
			}
			return j, data[:i], nil
		}
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	return 0, nil, nil
}

func readDecoder(c *conn, cfg *Config, verbose bool, capture *os.File, relay *relay, clock *ClockMap, board *Board, lastBy map[string]int64, count *int) {
	parser := NewParser()
	parser.RC2TimeUnitMs = cfg.RC2TimeUnitMs
	if verbose {
		parser.OnStatus = func(f, raw string) { fmt.Println("    status", f, raw) }
		parser.OnUnknown = func(raw string) { fmt.Println("    ?", raw) }
	}
	recognised := false
	process := func(b []byte) {
		relay.send(b)
		if capture != nil {
			fmt.Fprintf(capture, "%s %x\n", time.Now().Format("15:04:05.000"), b)
		}
		arrived := time.Now().UnixMilli()
		for _, p := range parser.Feed(b) {
			wall := clock.Wall(p.DecoderMs, arrived)
			board.AddPassing(p.Transponder, wall, int64(cfg.HeatGapSec*1000), int64(cfg.MinLapSec*1000))
			*count++
			lap := ""
			if prev := lastBy[p.Transponder]; prev > 0 && float64(wall-prev) >= cfg.MinLapSec*1000 && wall-prev < 10*60_000 {
				lap = "lap " + fmtLap(wall-prev)
			}
			lastBy[p.Transponder] = wall
			fmt.Printf("#%-5d %s  transponder %-9s %s\n", *count, time.UnixMilli(wall).Format("15:04:05.000"), p.Transponder, lap)
			logPassing(wall, p)
		}
		if parser.Seen != "" && !recognised {
			recognised = true
			fmt.Println("OK  decoder format:", parser.Seen)
		}
	}
	if len(c.first) > 0 {
		process(c.first)
	}
	buf := make([]byte, 4096)
	for {
		n, err := c.src.Read(buf)
		if n > 0 {
			process(buf[:n])
		}
		if err != nil && err != io.EOF {
			fmt.Println("!!  decoder connection lost:", err)
			return
		}
		if err == io.EOF && !strings.HasPrefix(c.desc, "serial") {
			fmt.Println("!!  decoder closed the connection (another program may be connected to it)")
			return
		}
	}
}

// logPassing keeps a local backup (CSV, one file per day).
func logPassing(wall int64, p Passing) {
	f, err := os.OpenFile(filepath.Join(exeDir(), "logs", "passings-"+time.UnixMilli(wall).Format("2006-01-02")+".csv"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err == nil {
		fmt.Fprintf(f, "%s,%d,%s,%d,%s,%d,%d,%s\n", time.UnixMilli(wall).Format("15:04:05.000"), wall, p.Transponder, p.DecoderMs, p.DecoderID, p.Hits, p.Strength, p.Raw)
		f.Close()
	}
}

func fmtLap(ms int64) string {
	m := ms / 60000
	s := float64(ms%60000) / 1000
	if m > 0 {
		return fmt.Sprintf("%d:%06.3f", m, s)
	}
	return fmt.Sprintf("%.3f", s)
}

// ------------------------------------------------------------------ relay (share the decoder)

type relay struct {
	mu      sync.Mutex
	clients []net.Conn
}

// startRelay lets another program (e.g. the old timing software) read the same decoder stream from
// 127.0.0.1:<port>, for decoders that accept only one connection.
func startRelay(port int) *relay {
	r := &relay{}
	if port <= 0 {
		return r
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		fmt.Println("!!  relay port", port, "not available:", err)
		return r
	}
	fmt.Printf("    relay: other programs can read the decoder at 127.0.0.1:%d\n", port)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			r.mu.Lock()
			r.clients = append(r.clients, c)
			r.mu.Unlock()
		}
	}()
	return r
}

func (r *relay) send(b []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	keep := r.clients[:0]
	for _, c := range r.clients {
		_ = c.SetWriteDeadline(time.Now().Add(time.Second))
		if _, err := c.Write(b); err == nil {
			keep = append(keep, c)
		} else {
			c.Close()
		}
	}
	r.clients = keep
}

// ------------------------------------------------------------------ helpers / diagnostics

func listPorts() {
	ports, err := serial.GetPortsList()
	if err != nil || len(ports) == 0 {
		fmt.Println("No COM ports found.")
		return
	}
	for _, p := range ports {
		fmt.Println("  ", p)
	}
}

// find lists COM ports and scans this laptop's local networks for RentiX and network decoders.
func find(cfg Config) {
	listPorts()
	found := scanLAN([]int{cfg.RentixPort, 5403, 5100}, true)
	for _, a := range found {
		what := "decoder"
		if a.port == cfg.RentixPort {
			what = "RentiX"
		}
		fmt.Printf("FOUND  %s at %s port %d\n", what, a.host, a.port)
	}
	if len(found) == 0 {
		fmt.Println("Nothing found on the network. A serial/USB decoder is found by itself when the bridge starts.")
	}
}

// sim: no hardware. A simulated decoder heat, served to the staff page like the real thing.
func sim(cfg Config, karts int, first uint32, speed float64) {
	board := NewBoard()
	board.SetConn(true, "decoder", "")
	serveBoard(board, cfg.LocalPort)
	fmt.Printf("SIM: %d karts, transponders %d..%d. Open the staff page on this computer. (Not for use during real heats.)\n", karts, first, first+uint32(karts)-1)
	next := make([]time.Time, karts)
	pace := make([]float64, karts)
	for i := range next {
		pace[i] = 36 + rand.Float64()*9
		next[i] = time.Now().Add(time.Duration(rand.Float64() * 3 / speed * float64(time.Second)))
	}
	for {
		time.Sleep(50 * time.Millisecond)
		for i := range next {
			if time.Now().After(next[i]) {
				board.AddPassing(strconv.Itoa(int(first)+i), time.Now().UnixMilli(), int64(cfg.HeatGapSec*1000), int64(cfg.MinLapSec*1000/speed))
				next[i] = time.Now().Add(time.Duration((pace[i] + (rand.Float64()-0.5)*3) / speed * float64(time.Second)))
			}
		}
	}
}

// fakeRentix pretends to be RentiX's RMonitor feed (testing).
func fakeRentix(port, karts int, speed float64) {
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		fmt.Println("!!", err)
		os.Exit(1)
	}
	fmt.Printf("Fake RentiX on port %d with %d karts\n", port, karts)
	for {
		c, err := ln.Accept()
		if err != nil {
			continue
		}
		go func(c net.Conn) {
			defer c.Close()
			w := func(s string) bool { _, err := c.Write([]byte(s + "\r\n")); return err == nil }
			w(`$I,"12:00:00","16 Nov 26"`)
			w(`$B,7,"Heat 7"`)
			for i := 1; i <= karts; i++ {
				w(fmt.Sprintf(`$A,"%d","%d",%d,"Driver","%d","",1`, i, i, 1000000+i, i))
			}
			start := time.Now()
			laps := make([]int, karts+1)
			next := make([]time.Duration, karts+1)
			for i := 1; i <= karts; i++ {
				next[i] = time.Duration((38 + rand.Float64()*6) / speed * float64(time.Second))
			}
			for {
				time.Sleep(50 * time.Millisecond)
				el := time.Since(start)
				for i := 1; i <= karts; i++ {
					if el >= next[i] {
						laps[i]++
						lap := 38 + rand.Float64()*6
						if !w(fmt.Sprintf(`$J,"%d","%s","%s"`, i, clockStr(int64(lap*1000)), clockStr(el.Milliseconds()))) {
							return
						}
						w(fmt.Sprintf(`$G,%d,"%d",%d,"%s"`, i, i, laps[i], clockStr(el.Milliseconds())))
						next[i] = el + time.Duration(lap/speed*float64(time.Second))
					}
				}
				if !w(fmt.Sprintf(`$F,9999,"00:%02d:00","%s","%s","Green"`, 10-int(el.Minutes())%10, time.Now().Format("15:04:05"), clockStr(el.Milliseconds()))) {
					return
				}
				time.Sleep(time.Second)
			}
		}(c)
	}
}

// fakeDecoder pretends to be a decoder on TCP so the bridge can be tested without hardware.
func fakeDecoder(port int, format string, karts int, first uint32, speed float64) {
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		fmt.Println("!!", err)
		os.Exit(1)
	}
	fmt.Printf("Fake %s decoder on port %d with %d karts. Point the bridge at it: dk-bridge -host 127.0.0.1 -port %d\n", format, port, karts, port)
	boot := time.Now()
	for {
		c, err := ln.Accept()
		if err != nil {
			continue
		}
		fmt.Println("client connected:", c.RemoteAddr())
		go func(c net.Conn) {
			defer c.Close()
			next := make([]time.Duration, karts)
			pace := make([]float64, karts)
			for i := range next {
				pace[i] = 36 + rand.Float64()*9
				next[i] = time.Since(boot) + time.Duration(rand.Float64()*3*float64(time.Second))
			}
			n := uint32(1)
			lastBeat := time.Now()
			for {
				time.Sleep(20 * time.Millisecond)
				el := time.Since(boot)
				for i := range next {
					if el >= next[i] {
						var msg []byte
						if format == "rc2" {
							msg = []byte(EncodeRC2Passing(first+uint32(i), uint32(el.Milliseconds())))
						} else {
							msg = EncodeP3Passing(n, first+uint32(i), uint64(time.Now().UnixMicro()), 0x0A1B2C)
						}
						n++
						if _, err := c.Write(msg); err != nil {
							fmt.Println("client gone")
							return
						}
						lap := (pace[i] + (rand.Float64()-0.5)*3) / speed
						next[i] = el + time.Duration(lap*float64(time.Second))
					}
				}
				if format == "rc2" && time.Since(lastBeat) > time.Second {
					_, _ = c.Write([]byte("#690F\r\n"))
					lastBeat = time.Now()
				}
			}
		}(c)
	}
}
