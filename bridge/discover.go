package main

// Finding the decoder by itself, so the owner never has to type a port or an address:
//  1. the connection saved last time (bridge.json), if it still works;
//  2. every COM port at every common speed, until real decoder data is recognised;
//  3. the laptop's local network, TCP 5403 (AMB P3) and 5100 (legacy).
// What is found is saved in bridge.json, so the next start connects at once.

import (
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.bug.st/serial"
)

// conn is an open decoder connection plus any bytes already read while probing it.
type conn struct {
	src   io.ReadCloser
	desc  string
	first []byte
}

func openTCP(host string, port int) (net.Conn, error) {
	return net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), 4*time.Second)
}

func openSerial(port string, baud int) (serial.Port, error) {
	p, err := serial.Open(port, &serial.Mode{BaudRate: baud, DataBits: 8, Parity: serial.NoParity, StopBits: serial.OneStopBit})
	if err != nil {
		return nil, err
	}
	_ = p.SetReadTimeout(500 * time.Millisecond)
	return p, nil
}

func busyErr(err error) bool {
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "busy") || strings.Contains(s, "denied") || strings.Contains(s, "in use")
}

// probe reads for up to d and reports whether decoder data was recognised.
func probe(r io.Reader, d time.Duration) ([]byte, bool) {
	p := NewParser()
	var got []byte
	buf := make([]byte, 1024)
	end := time.Now().Add(d)
	for time.Now().Before(end) {
		n, err := r.Read(buf)
		if n > 0 {
			got = append(got, buf[:n]...)
			p.Feed(buf[:n])
			if p.Seen != "" {
				return got, true
			}
		}
		if err != nil && err != io.EOF {
			break
		}
	}
	return got, false
}

// connect returns a working decoder connection, searching for one if needed.
func connect(cfg *Config) (*conn, error) {
	// 1. saved / configured connection
	if cfg.Connection == "tcp" || cfg.DecoderHost != "" {
		c, err := openTCP(cfg.DecoderHost, cfg.DecoderPort)
		if err == nil {
			return &conn{src: c, desc: fmt.Sprintf("tcp %s:%d", cfg.DecoderHost, cfg.DecoderPort)}, nil
		}
		if cfg.Connection == "tcp" {
			return nil, fmt.Errorf("decoder %s:%d not reachable: %v", cfg.DecoderHost, cfg.DecoderPort, err)
		}
		fmt.Printf("    saved decoder %s:%d not answering, searching again...\n", cfg.DecoderHost, cfg.DecoderPort)
	}
	if cfg.Connection != "tcp" && cfg.ComPort != "" && !strings.EqualFold(cfg.ComPort, "auto") && cfg.Baud > 0 {
		p, err := openSerial(cfg.ComPort, cfg.Baud)
		if err == nil {
			return &conn{src: p, desc: fmt.Sprintf("serial %s @ %d", cfg.ComPort, cfg.Baud)}, nil
		}
		if busyErr(err) {
			return nil, fmt.Errorf("%s is in use by another program. Close the old timing program (the other CMD window)", cfg.ComPort)
		}
		if cfg.Connection == "serial" {
			return nil, fmt.Errorf("%s: %v", cfg.ComPort, err)
		}
		fmt.Printf("    saved port %s not available (%v), searching again...\n", cfg.ComPort, err)
	}

	fmt.Println("    searching for the decoder...")
	var busy []string
	// 2. serial ports
	if cfg.Connection != "tcp" {
		ports, _ := serial.GetPortsList()
		sort.Sort(sort.Reverse(sort.StringSlice(ports))) // USB adapters usually have the highest number
		speeds := bauds
		if cfg.Baud > 0 {
			speeds = []int{cfg.Baud}
		}
		for _, port := range ports {
			for _, b := range speeds {
				p, err := openSerial(port, b)
				if err != nil {
					if busyErr(err) {
						busy = append(busy, port)
					}
					break
				}
				fmt.Printf("    trying %s at %d...\n", port, b)
				got, ok := probe(p, 2500*time.Millisecond)
				if ok {
					cfg.Connection, cfg.ComPort, cfg.Baud, cfg.DecoderHost = "auto", port, b, ""
					saveConfig(*cfg)
					fmt.Printf("OK  found the decoder on %s at %d (saved)\n", port, b)
					return &conn{src: p, desc: fmt.Sprintf("serial %s @ %d", port, b), first: got}, nil
				}
				p.Close()
			}
		}
	}
	// 3. network
	if cfg.Connection != "serial" {
		for _, a := range scanLAN([]int{5403, 5100}, false) {
			c, err := openTCP(a.host, a.port)
			if err != nil {
				continue
			}
			_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
			got, _ := probe(c, 3*time.Second)
			_ = c.SetReadDeadline(time.Time{})
			cfg.Connection, cfg.DecoderHost, cfg.DecoderPort = "auto", a.host, a.port
			saveConfig(*cfg)
			fmt.Printf("OK  found the decoder at %s:%d (saved)\n", a.host, a.port)
			return &conn{src: c, desc: fmt.Sprintf("tcp %s:%d", a.host, a.port), first: got}, nil
		}
	}
	if len(busy) > 0 {
		return nil, fmt.Errorf("decoder not found. %s is in use by another program: close the old timing program (the other CMD window)", strings.Join(busy, ", "))
	}
	return nil, fmt.Errorf("decoder not found (no decoder data on any COM port, nothing on the network). Is the decoder on and its cable plugged in?")
}

type addr struct {
	host string
	port int
}

// scanLAN looks for open decoder ports on this laptop's local networks.
func scanLAN(ports []int, verbose bool) []addr {
	var out []addr
	var mu sync.Mutex
	ifs, _ := net.InterfaceAddrs()
	for _, a := range ifs {
		ipn, ok := a.(*net.IPNet)
		if !ok || ipn.IP.To4() == nil || ipn.IP.IsLoopback() || ipn.IP.IsLinkLocalUnicast() {
			continue
		}
		base := ipn.IP.To4()
		if verbose {
			fmt.Printf("Scanning %d.%d.%d.1-254 (this laptop is %s) ...\n", base[0], base[1], base[2], base)
		}
		var wg sync.WaitGroup
		for i := 1; i < 255; i++ {
			if byte(i) == base[3] {
				continue
			}
			for _, pt := range ports {
				wg.Add(1)
				go func(ip string, pt int) {
					defer wg.Done()
					c, err := net.DialTimeout("tcp", net.JoinHostPort(ip, strconv.Itoa(pt)), 700*time.Millisecond)
					if err == nil {
						c.Close()
						mu.Lock()
						out = append(out, addr{ip, pt})
						mu.Unlock()
					}
				}(fmt.Sprintf("%d.%d.%d.%d", base[0], base[1], base[2], i), pt)
			}
		}
		wg.Wait()
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].port > out[j].port || (out[i].port == out[j].port && out[i].host < out[j].host)
	})
	return out
}

// ------------------------------------------------------------------ install (start with Windows)

const startupName = "DanKarting-bridge.cmd"

func startupCmd() string {
	return fmt.Sprintf("@echo off\r\ntitle Dan Karting - decoder bridge\r\ncd /d \"%s\"\r\n\"%s\" run\r\npause\r\n", exeDir(), filepath.Join(exeDir(), filepath.Base(os.Args[0])))
}

func startupDirs() (startup, desktop string) {
	startup = filepath.Join(os.Getenv("APPDATA"), `Microsoft\Windows\Start Menu\Programs\Startup`)
	desktop = filepath.Join(os.Getenv("USERPROFILE"), "Desktop")
	if od := filepath.Join(os.Getenv("USERPROFILE"), "OneDrive", "Desktop"); dirExists(od) && !dirExists(desktop) {
		desktop = od
	}
	return
}

func dirExists(p string) bool { st, err := os.Stat(p); return err == nil && st.IsDir() }

// install: the bridge starts by itself every time Windows starts, plus a desktop icon. Then it runs now.
func install(cfg Config) {
	if runtime.GOOS != "windows" {
		fmt.Println("install works on Windows only")
		return
	}
	startup, desktop := startupDirs()
	for _, d := range []string{startup, desktop} {
		if !dirExists(d) {
			continue
		}
		if err := os.WriteFile(filepath.Join(d, startupName), []byte(startupCmd()), 0o644); err != nil {
			fmt.Println("!! ", err)
		} else {
			fmt.Println("OK  ", filepath.Join(d, startupName))
		}
	}
	fmt.Println("OK  installed: the bridge now starts by itself when this laptop starts (and from the desktop icon).")
	run(cfg, true)
}

func uninstall() {
	startup, desktop := startupDirs()
	for _, d := range []string{startup, desktop} {
		if err := os.Remove(filepath.Join(d, startupName)); err == nil {
			fmt.Println("removed", filepath.Join(d, startupName))
		}
	}
	fmt.Println("The bridge no longer starts with Windows.")
}
