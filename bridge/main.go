// dk-bridge: reads lap passings from the AMB decoder at the track and sends them to the Dan Karting
// app (Supabase) in real time. Runs from CMD on the track laptop. See docs/BRIDGE-HE.md.
//
//	dk-bridge              run (reads bridge.json next to the program)
//	dk-bridge listen       show what the decoder sends, upload nothing (first test on site)
//	dk-bridge ports        list COM ports
//	dk-bridge find         look for a network decoder (TCP 5403 / 5100) on this laptop's network
//	dk-bridge sim          no decoder: send simulated passings to the app (test the whole chain)
//	dk-bridge fake-decoder pretend to be a decoder on TCP (for testing the bridge itself)
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
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.bug.st/serial"
)

const version = "1.0.0"

type Config struct {
	Connection    string  `json:"connection"` // auto | serial | tcp
	ComPort       string  `json:"com_port"`   // auto | COM3 ...
	Baud          int     `json:"baud"`       // 0 = try common speeds
	DecoderHost   string  `json:"decoder_host"`
	DecoderPort   int     `json:"decoder_port"`
	SupabaseURL   string  `json:"supabase_url"`
	SupabaseKey   string  `json:"supabase_key"`
	User          string  `json:"user"`
	Password      string  `json:"password"`
	RC2TimeUnitMs float64 `json:"rc2_time_unit_ms"`
	RelayPort     int     `json:"relay_port"` // >0: re-serve the raw decoder stream on 127.0.0.1:<port>
	MinLapSec     float64 `json:"min_lap_sec"` // console display only; the app has its own setting
}

func defaults() Config {
	return Config{
		Connection: "auto", ComPort: "auto", Baud: 0, DecoderPort: 5403,
		SupabaseURL: "https://fqytpdapnvbpfonatopt.supabase.co",
		SupabaseKey: "sb_publishable_RANVYVqyzWASfwYdThRXtQ_SHfUjJa9",
		User:        "admin", RC2TimeUnitMs: 1, MinLapSec: 15,
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
		fmt.Println("Created settings file:", configPath())
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
	fs.StringVar(&cfg.DecoderHost, "host", cfg.DecoderHost, "decoder IP (network decoder)")
	fs.IntVar(&cfg.DecoderPort, "port", cfg.DecoderPort, "decoder TCP port")
	fs.StringVar(&cfg.ComPort, "com", cfg.ComPort, "COM port (serial decoder), or auto")
	fs.IntVar(&cfg.Baud, "baud", cfg.Baud, "serial speed, 0 = auto")
	fs.StringVar(&cfg.Connection, "connection", cfg.Connection, "auto | serial | tcp")
	karts := fs.Int("karts", 8, "sim: number of karts")
	first := fs.Int("first", 1000001, "sim/fake-decoder: first transponder number")
	speed := fs.Float64("speed", 1, "sim/fake-decoder: time speed-up")
	format := fs.String("format", "p3", "fake-decoder: p3 | rc2")
	listenPort := fs.Int("listen", 5403, "fake-decoder: TCP port to serve")
	_ = fs.Parse(args)

	fmt.Printf("Dan Karting decoder bridge %s\n", version)
	switch cmd {
	case "run":
		run(cfg, true)
	case "listen":
		run(cfg, false)
	case "ports":
		listPorts()
	case "find":
		find(cfg.DecoderPort)
	case "sim":
		sim(cfg, *karts, uint32(*first), *speed)
	case "fake-decoder":
		fakeDecoder(*listenPort, *format, *karts, uint32(*first), *speed)
	default:
		fmt.Println("Unknown command:", cmd, "\nUse: run | listen | ports | find | sim | fake-decoder")
		os.Exit(2)
	}
}

func askPassword(cfg *Config) {
	if cfg.Password != "" {
		return
	}
	fmt.Printf("Password for staff user %q (same as the app's staff login): ", cfg.User)
	line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	cfg.Password = strings.TrimSpace(line)
	saved := *cfg
	saveConfig(saved)
	fmt.Println("Saved in bridge.json (delete it from there to be asked again).")
}

// ------------------------------------------------------------------ decoder connection

// openSource connects to the decoder and returns a reader plus a description.
func openSource(cfg Config, baud int) (io.ReadCloser, string, error) {
	useTCP := cfg.Connection == "tcp" || (cfg.Connection == "auto" && cfg.DecoderHost != "")
	if useTCP {
		if cfg.DecoderHost == "" {
			return nil, "", fmt.Errorf("decoder_host is empty in bridge.json (run: dk-bridge find)")
		}
		addr := net.JoinHostPort(cfg.DecoderHost, strconv.Itoa(cfg.DecoderPort))
		c, err := net.DialTimeout("tcp", addr, 5*time.Second)
		if err != nil {
			return nil, "", err
		}
		return c, "tcp " + addr, nil
	}
	port := cfg.ComPort
	if port == "" || strings.EqualFold(port, "auto") {
		ports, err := serial.GetPortsList()
		if err != nil || len(ports) == 0 {
			return nil, "", fmt.Errorf("no COM port found. Is the decoder cable (USB/RS-232) plugged in?")
		}
		sort.Strings(ports)
		port = ports[len(ports)-1] // USB adapters usually get the highest number
		if len(ports) > 1 {
			fmt.Printf("   COM ports: %s - trying %s (set com_port in bridge.json to choose)\n", strings.Join(ports, ", "), port)
		}
	}
	p, err := serial.Open(port, &serial.Mode{BaudRate: baud, DataBits: 8, Parity: serial.NoParity, StopBits: serial.OneStopBit})
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "busy") || strings.Contains(strings.ToLower(err.Error()), "denied") {
			return nil, "", fmt.Errorf("%s is in use by another program. Close the old timing program (the other CMD window) and try again", port)
		}
		return nil, "", fmt.Errorf("%s: %w", port, err)
	}
	_ = p.SetReadTimeout(time.Second)
	return p, fmt.Sprintf("serial %s @ %d", port, baud), nil
}

var bauds = []int{9600, 19200, 38400, 57600, 115200}

type state struct {
	mu        sync.Mutex
	Connected bool
	Source    string
	Format    string
	Count     int
	LastTx    string
	LastAt    int64
	Err       string
	lastByTx  map[string]int64
}

func run(cfg Config, upload bool) {
	var cloud *Cloud
	if upload {
		askPassword(&cfg)
		cloud = NewCloud(cfg.SupabaseURL, cfg.SupabaseKey, cfg.User, cfg.Password)
		if err := cloud.SignIn(); err != nil {
			fmt.Println("!!", err)
			fmt.Println("   Check user/password in bridge.json and the internet connection. Passings will be kept and sent later.")
		} else {
			fmt.Println("OK  signed in to the app as", cloud.Email)
		}
	} else {
		fmt.Println("LISTEN mode: showing decoder data only, nothing is sent to the app.")
	}
	st := &state{lastByTx: map[string]int64{}}
	logDir := filepath.Join(exeDir(), "logs")
	_ = os.MkdirAll(logDir, 0o755)
	var capture *os.File
	if !upload {
		capture, _ = os.Create(filepath.Join(logDir, "capture-"+time.Now().Format("20060102-150405")+".txt"))
		if capture != nil {
			fmt.Println("    raw capture:", capture.Name())
		}
	}
	relay := startRelay(cfg.RelayPort)

	if cloud != nil {
		go func() { // uploader
			lastMsg := time.Time{}
			for {
				time.Sleep(500 * time.Millisecond)
				if err := cloud.Flush(); err != nil && time.Since(lastMsg) > 15*time.Second {
					fmt.Printf("!!  upload failed (%d waiting, will retry): %v\n", cloud.Pending(), err)
					lastMsg = time.Now()
				}
			}
		}()
		go func() { // heartbeat for the app's settings screen
			for {
				st.mu.Lock()
				data := map[string]any{"version": version, "connected": st.Connected, "source": st.Source, "format": st.Format, "passings": st.Count, "lastTransponder": st.LastTx, "lastAt": st.LastAt, "error": st.Err, "pending": cloud.Pending(), "sentAt": time.Now().UnixMilli()}
				st.mu.Unlock()
				_ = cloud.Status(data)
				time.Sleep(10 * time.Second)
			}
		}()
	}

	clock := &ClockMap{}
	baudIdx := 0
	for attempt := 0; ; attempt++ {
		baud := cfg.Baud
		if baud == 0 {
			baud = bauds[baudIdx%len(bauds)]
		}
		src, desc, err := openSource(cfg, baud)
		if err != nil {
			st.set(func() { st.Connected, st.Err = false, err.Error() })
			fmt.Println("!! ", err, "- retrying in 5 s")
			time.Sleep(5 * time.Second)
			continue
		}
		fmt.Println("OK  connected to decoder:", desc)
		st.set(func() { st.Connected, st.Source, st.Err = true, desc, "" })
		parser := NewParser()
		parser.RC2TimeUnitMs = cfg.RC2TimeUnitMs
		parser.OnStatus = func(f, raw string) {
			if !upload {
				fmt.Println("    status", f, raw)
			}
		}
		parser.OnUnknown = func(raw string) {
			if !upload {
				fmt.Println("    ?", raw)
			}
		}
		opened := time.Now()
		buf := make([]byte, 4096)
		recognised := false
		for {
			n, err := src.Read(buf)
			if n > 0 {
				relay.send(buf[:n])
				if capture != nil {
					fmt.Fprintf(capture, "%s %x\n", time.Now().Format("15:04:05.000"), buf[:n])
				}
				arrived := time.Now().UnixMilli()
				for _, p := range parser.Feed(buf[:n]) {
					handle(p, clock.Wall(p.DecoderMs, arrived), st, cloud, logDir, cfg)
				}
				if parser.Seen != "" && !recognised {
					recognised = true
					fmt.Println("OK  decoder format:", parser.Seen)
					st.set(func() { st.Format = parser.Seen })
				}
			}
			if err != nil && err != io.EOF {
				fmt.Println("!!  decoder connection lost:", err)
				break
			}
			if err == io.EOF && !strings.HasPrefix(desc, "serial") {
				fmt.Println("!!  decoder closed the connection (another program may be connected to it)")
				break
			}
			// serial with automatic speed: nothing recognisable after 4 s -> try the next speed
			if cfg.Baud == 0 && strings.HasPrefix(desc, "serial") && !recognised && time.Since(opened) > 4*time.Second {
				fmt.Printf("    no decoder data at %d baud, trying the next speed\n", baud)
				baudIdx++
				break
			}
		}
		src.Close()
		st.set(func() { st.Connected = false })
		time.Sleep(2 * time.Second)
	}
}

func (s *state) set(f func()) { s.mu.Lock(); f(); s.mu.Unlock() }

func handle(p Passing, wall int64, st *state, cloud *Cloud, logDir string, cfg Config) {
	// same decoder + decoder time + transponder = the same crossing (a resend); passing numbers alone
	// are not used because they restart when the decoder is switched off and on
	uid := fmt.Sprintf("%s-%d-%s", p.DecoderID, p.DecoderMs, p.Transponder)
	st.mu.Lock()
	prev := st.lastByTx[p.Transponder]
	st.lastByTx[p.Transponder] = wall
	st.Count++
	st.LastTx, st.LastAt = p.Transponder, wall
	count := st.Count
	st.mu.Unlock()
	lap := ""
	if prev > 0 && float64(wall-prev) >= cfg.MinLapSec*1000 && wall-prev < 10*60_000 {
		lap = "lap " + fmtLap(wall-prev)
	}
	fmt.Printf("#%-5d %s  transponder %-9s %s\n", count, time.UnixMilli(wall).Format("15:04:05.000"), p.Transponder, lap)
	// local backup log (CSV, one file per day)
	f, err := os.OpenFile(filepath.Join(logDir, "passings-"+time.UnixMilli(wall).Format("2006-01-02")+".csv"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err == nil {
		fmt.Fprintf(f, "%s,%d,%s,%d,%s,%d,%d,%s\n", time.UnixMilli(wall).Format("15:04:05.000"), wall, p.Transponder, p.DecoderMs, p.DecoderID, p.Hits, p.Strength, p.Raw)
		f.Close()
	}
	if cloud != nil {
		cloud.Enqueue(Row{UID: uid, Transponder: p.Transponder, T: wall, DecoderT: p.DecoderMs, Decoder: p.DecoderID, Hits: p.Hits, Strength: p.Strength})
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

// find scans this laptop's local networks for a decoder port (5403 = P3, 5100 = legacy).
func find(port int) {
	ports := []int{port}
	if port != 5100 {
		ports = append(ports, 5100)
	}
	ifs, _ := net.InterfaceAddrs()
	found := 0
	for _, a := range ifs {
		ipn, ok := a.(*net.IPNet)
		if !ok || ipn.IP.To4() == nil || ipn.IP.IsLoopback() {
			continue
		}
		base := ipn.IP.To4()
		fmt.Printf("Scanning %d.%d.%d.1-254 (this laptop is %s) ...\n", base[0], base[1], base[2], base)
		var wg sync.WaitGroup
		var mu sync.Mutex
		for i := 1; i < 255; i++ {
			for _, pt := range ports {
				wg.Add(1)
				go func(ip string, pt int) {
					defer wg.Done()
					c, err := net.DialTimeout("tcp", net.JoinHostPort(ip, strconv.Itoa(pt)), 700*time.Millisecond)
					if err == nil {
						c.Close()
						mu.Lock()
						found++
						fmt.Printf("FOUND  %s port %d   -> put \"decoder_host\": \"%s\", \"decoder_port\": %d in bridge.json\n", ip, pt, ip, pt)
						mu.Unlock()
					}
				}(fmt.Sprintf("%d.%d.%d.%d", base[0], base[1], base[2], i), pt)
			}
		}
		wg.Wait()
	}
	if found == 0 {
		fmt.Println("No network decoder found. If the decoder is connected with a serial/USB cable, leave decoder_host empty and run: dk-bridge ports")
	}
}

// sim sends simulated passings straight to the app: tests app + cloud without any decoder.
func sim(cfg Config, karts int, first uint32, speed float64) {
	askPassword(&cfg)
	cloud := NewCloud(cfg.SupabaseURL, cfg.SupabaseKey, cfg.User, cfg.Password)
	if err := cloud.SignIn(); err != nil {
		fmt.Println("!!", err)
		os.Exit(1)
	}
	fmt.Printf("SIM: %d karts, transponders %d..%d. Map them to karts in the app (Settings), start a heat, and watch the laps.\n", karts, first, first+uint32(karts)-1)
	st := &state{lastByTx: map[string]int64{}}
	_ = cloud.Status(map[string]any{"version": version, "connected": true, "source": "SIMULATOR", "format": "sim", "sentAt": time.Now().UnixMilli()})
	next := make([]time.Time, karts)
	pace := make([]float64, karts)
	for i := range next {
		pace[i] = 36 + rand.Float64()*9
		next[i] = time.Now().Add(time.Duration((5 + rand.Float64()*5) / speed * float64(time.Second)))
	}
	logDir := filepath.Join(exeDir(), "logs")
	_ = os.MkdirAll(logDir, 0o755)
	beat := time.Now()
	for n := 1; ; {
		time.Sleep(50 * time.Millisecond)
		for i := range next {
			if time.Now().After(next[i]) {
				p := Passing{Transponder: strconv.Itoa(int(first) + i), DecoderMs: time.Now().UnixMilli(), DecoderID: "SIM", PassingNo: int64(n)}
				n++
				handle(p, time.Now().UnixMilli(), st, cloud, logDir, Config{MinLapSec: 1})
				lap := (pace[i] + (rand.Float64()-0.5)*3) / speed
				next[i] = time.Now().Add(time.Duration(lap * float64(time.Second)))
			}
		}
		if err := cloud.Flush(); err != nil {
			fmt.Println("!! upload:", err)
		}
		if time.Since(beat) > 10*time.Second {
			_ = cloud.Status(map[string]any{"version": version, "connected": true, "source": "SIMULATOR", "format": "sim", "passings": st.Count, "lastTransponder": st.LastTx, "lastAt": st.LastAt, "sentAt": time.Now().UnixMilli()})
			beat = time.Now()
		}
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
