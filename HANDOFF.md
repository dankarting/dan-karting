# Dan Karting demo - handoff (separate from Helper project)

Hebrew RTL, phone-first React app. Synthetic data only. No real venue integration, no customer data, no prices, no payments, no safety/age/height rules, no vehicle controls, no spoken announcements, no Vmax parity claims.

## Source
- src/logic.ts - pure logic: groups, planHeats, manual heats, cashier overrides on queued heats, driver names/karts, queue + call-up, live run (start/speed/finish/cancel), simulated TimingFeed, history.
- tests/logic.test.ts - `npx tsx tests/logic.test.ts` (counted harness, 16 cases, exits 1 on failure).
- src/App.tsx - tabs: form (customer signup), cashier (pending payment + paid groups), heats, live (track and queue), history, settings. TrackScreen (switches by itself between race, call, next and empty), WallDisplay, CallDisplay, DriverEditor.
- src/style.css - dark carbon theme with red/yellow accents; maps host --ds-* tokens to the dark palette.
- shim/instinct-files.tsx + vite.config.ts + tsconfig.json + index.html + package.json - standalone run only.

## Public timing website (added 2026-11-15, owner chose a real public site)
- Root URL = read-only public board (PublicBoard in App.tsx): call-up screen and live timing, no login.
  Staff app = same URL with `?staff`, behind a staff sign-in gate (StaffGate). Login takes a user name;
  `admin` maps to admin@dankarting.app (Cloud.staffEmail). The owner creates staff users in Supabase Auth.
- Backend: Supabase project fqytpdapnvbpfonatopt, table public.live_board (row id 'main', data jsonb).
  RLS: anyone can SELECT; only `authenticated` can UPDATE. Sign-ups must stay DISABLED in Supabase Auth so only
  staff accounts the owner creates can sign in. Realtime publication includes the table. Setup SQL: docs/supabase-setup.sql.
- src/cloud.ts: client (publishable key, public by design), publishBoard / fetchBoard / subscribeBoard / signIn.
- Staff device: Settings -> "אתר צפייה ציבורי" -> staff sign-in -> "התחל לשדר לאתר". Every core change is pushed
  (debounced 300 ms). Unpaid form submissions are stripped before sending (boardOf).
- Viewers run the race clock locally from the race start time in the board (relies on network-synced device clocks).
- Hosting: GitHub Pages from branch gh-pages (built dist/, vite base './').

- Public heat history: staff device publishes the last 30 finished heats (BoardPayload.hist); the public page has a
  "היסטוריית מקצים" button (read-only list, search by name).

## Shared staff state across computers (owner, 2026-11-16)
- src/shared.ts useShared(key): core and hist live in Supabase public.staff_state (rows 'core', 'hist'; staff-only RLS;
  docs/staff-sync.sql). Edits stay functions (core => core): applied locally at once, then saved with a rev check;
  on conflict the newest copy is loaded and the pending functions are replayed on it. Realtime + 5 s poll fallback.
  Offline keeps working from the local copy (localStorage cache) and catches up; pending edits are lost if the page
  reloads while offline. First computer to connect seeds an empty cloud row from its local data.
- Brand bar shows sync state (מסונכרן / שומר / לא מחובר).

## RentiX live timing (ported from the gen 5 branch, 2026-11-16)
- public/rentix-bridge.ps1 on the staff laptop reads RentiX RMonitor (TCP 192.168.0.1:50000) and serves it on
  localhost:8787. src/rentix.ts parses it; while it has drivers the track screen, Live tab and public site show it.
- bridge/ (dk-bridge.exe, Go) replaces the ps1 on the same localhost:8787: RentiX first (read-only), else the AMB
  decoder directly (source "decoder", transponder -> kart map in Settings). One timing path. docs/BRIDGE-HE.md.
  Not yet tested against the real hardware.

## Heat history: permanent archive + daily/weekly reset (owner, 2026-11-16)
- Every finished heat is inserted into Supabase table public.heat_history (docs/heat-history.sql; anon read, staff insert only).
  The staff device also back-fills its local history to the archive whenever a staff session starts.
- "Current" history (History tab + public site) restarts at local midnight (settings.histReset 'day', default) or
  Saturday night -> Sunday 00:00 ('week'). Nothing is deleted; History tab has "ארכיון מלא" (cloud + device, merged).
- Device copy of history is capped at ~2 MB (was 14 KB).

## Timed heats + manual start (owner, 2026-11-15)
- Heat length: Settings.heatMinutes, default 10, minimum 10, chips 10/20, stepper up to 30. Fixed into live.durationMs at start.
- When time is up each driver finishes the lap in progress, then is done (timedTiming). Board countdown = real time left.
- A heat NEVER starts by itself: the autopilot only calls heats and saves results; staff press "התחל מקצה".

## Ticket types and kart classes (owner, 2026-11-15)
- Tickets: רגיל, זוגי, ליגה, מאסטר (יחיד renamed רגיל: on the board "ליחיד" means per person).
- Prices (10 min): רגיל 87, ליגה 87 (owner: same as regular), זוגי 100 per two-seat kart (pairTickets, priced per 2 people), מאסטר 100.
  20 min (settings.prices20): רגיל 100, ליגה 100 (owner: "20 דקות זה 100"); זוגי and מאסטר 20-min prices unknown.
- Heat length per registration: form + pending item pick 10 or 20 min (Submission.minutes -> Group.minutes). 10- and 20-minute
  groups never share a heat (fitsClass, canApprove, startBlockers); the heat runs minutesOfHeat.
- Form: picking זוגי inserts a partner name row under it (second seat); switching away removes it. ליגה + מאסטר = fast karts (settings.fastTickets, editable in Settings).
- Fast and regular never share a heat unless the group is marked family or the shift manager approves the mix (approveMix -> Heat.mixOk, tied to the exact groups; any change voids it) (Group.family): planner (fitsClass),
  approve (canApprove) and start (startBlockers) all enforce it. Old saved tickets migrate (migrateTickets).
- Cashier picks ticket + family on each pending registration; "שולם" = markPaidAndPlan (re-suggests drafts).
- Customer form: ticket chips next to EACH name (Submission.tickets) + running price total (settings.prices, set in
  Settings, display only). Cashier can change per-person tickets. A non-family registration with both fast and regular
  tickets is split on payment into two groups ("<name> (מהירות)"). Prices are not set by default (owner to supply).
- Open: זוגי is priced per pair and has 2 name rows, but still counts as 2 places in heat capacity (not 1 kart).

## Customer form -> payment -> queue (owner flow, supersedes cashier typing every name)
- Tab "הרשמה": the customer fills ONE group name + participant names. No other fields (no phone, email, age, price).
- The submission waits at the cashier under "ממתינים לתשלום". It is NOT in the queue and cannot be planned.
- Cashier presses "שולם · הכנס לתור" (SIMULATED staff confirmation: no payment processing) -> it becomes a group
  waiting for a heat, carrying the form names. Or "בטל הרשמה".
- After that the cashier keeps full control of heat composition as before. Driver labels come from the form names
  (continued across heats when a group is split); a name the cashier edits in "שמות וקארטים" wins.
- The old manual add (group by count, no names) is still there, collapsed: "הוספה ידנית בקופה (בלי טופס)".
- Logic: submitForm / markPaid / cancelSubmission / pendingOf in src/logic.ts; core.submissions; Group.names.
- Open: in production the form would run on customers' phones or a kiosk, which needs a shared backend (today
  everything is on one device). Whether the venue wants the cashier to pick ticket type / keep-together at payment is open
  (defaults: first ticket type, keep together).

## Owner vision
- Venue screen shows the called / next heat as a lineup board: driver "photo" cards with names and kart numbers.
  Photos are PLACEHOLDERS (an original helmet illustration per kart colour); no camera, no face recognition, no photo collection.
- Then it switches by itself to a red/dark live timing board: position (+ places gained vs grid), kart, name,
  S1/S2/S3, last lap, best lap, gap, laps, estimated time remaining, status lights / chequered flag.
  Purple = fastest in the heat, green = personal best. Original design; no vendor code or assets.
- Live tab: "הדגמה מלאה בלחיצה" loads demo groups, plans, fills synthetic names, approves, and starts the auto demo.
  "מלא שמות דמו" fills invented names only where none were entered. The cashier still controls everything.
- Sectors and timing are simulated. See docs/TIMING-INTEGRATION.md for the decoder seam (AMBrc2 over RS-232/USB reported, protocol not assumed).

## Flow (one coherent demo)
Cashier adds groups -> heats are suggested or built by hand -> cashier approves -> the approved heats form a simple queue (heat-number order, no time slots) -> a heat is called (screen shows "called") -> it starts (the race board takes over the screen; it leaves the queue) -> it finishes (clock freezes, results stay on screen, the next heat can already be called) -> it is saved to history (heat done) -> the called heat starts next.
- The auto demo (Live tab) runs this loop by itself. Its timers (DEMO in App.tsx: call 2.5 s, start 6 s, results 7 s, speed x20) are illustrative only.
- The live run is stored in core (`core.live`). The race and the auto demo keep running when you switch tabs or close the screen, and the race survives a reload. The auto demo flag itself is per session.
- Cashier override at any point until the heat goes on track: add, remove or move groups in draft AND approved/called heats (Heats tab). An approved heat that becomes invalid (empty, over capacity, kart clash, or missing karts in cashier mode) drops back to draft and leaves the queue, with a notice. Driver names and karts move with a moved group. The heat on track is locked.
- Any queued heat can be called, not only the first. Only one heat is called at a time, and only one is on track.
- startBlockers(): kart clash, over capacity (e.g. after capacity was lowered), empty, or another heat on track. Blocked heats cannot start; the auto demo waits and says why.

## Open decisions (do not settle silently)
- Capacity 10 vs 14: Settings offers both (10 is the default), plus a free stepper.
- Kart assignment: kartMode unset | cashier | staff. Cashier mode needs every kart chosen before approval. Staff mode shows "staff will assign" on the call screen until a kart is set, but does not block start (the simulation uses the suggested number). Still undecided: does the cashier assign karts by parking order or pick a kart for each name? No telemetry detection of parked karts.
- The real call-up trigger is not decided. Demo timers are illustrative only. Screen only, no spoken announcements.
- Timing is simulated. Seam: Passing[] -> lapsFromPassings() -> TimingFeed (see docs/TIMING-INTEGRATION.md). Decoder protocol, bridge, clock, transponder mapping and sector loops are open.
- Persistence: device-local only (useLocalState) for the cashier data. Only the board is shared, one way, via Supabase (see Public timing website). The track screen is an overlay on the same device.
- Queue order follows heat numbers. There is no drag-reorder; the cashier can call any queued heat out of order instead.
- Official logo: not bundled or hot-linked (no external calls). A text wordmark stands in until a local copy is placed and LOGO_SRC is set.

## Known gotchas
- Avoid dynamic native <select>: it crashed the hosted app (DOM removeChild). Only buttons and chips are used.
- '@instinct/files' API is mirrored by the shim from usage only. Check it against the real package on delivery.
