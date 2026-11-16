# Dan Karting demo - handoff (separate from Helper project)

Hebrew RTL, phone-first React app. Synthetic data only. No real venue integration, no customer data, no prices, no payments, no safety/age/height rules, no vehicle controls, no spoken announcements, no Vmax parity claims.

## Source
- src/logic.ts - pure logic: groups, planHeats, manual heats, cashier overrides on queued heats, driver names/karts, queue + call-up, live run (start/speed/finish/cancel), simulated TimingFeed, history.
- tests/logic.test.ts - `npx tsx tests/logic.test.ts` (counted harness, 24 cases, exits 1 on failure).
- src/App.tsx - core tabs: live/"מסלול" (queue, quick heat, venue screen with controls), heats, history, settings; add-on tabs (only when enabled): cashier, form. TrackScreen (switches by itself between race, call, next and empty), WallDisplay, CallDisplay, DriverEditor.
- src/style.css - dark carbon theme with red/yellow accents; maps host --ds-* tokens to the dark palette.
- shim/instinct-files.tsx + vite.config.ts + tsconfig.json + index.html + package.json - standalone run only.

## Marshal console + professional redesign (gen 5)
Owner (verbatim): "עכשיו תגיד לקלוד שלמרשלים יהיה כפתור למעלה של התחלה עצור ושמור ואפשרות לשנות שמות ולהתחיל ישר מקצא בלי שמות סבבה ושזה יאסף במסלול אתה מבין כמו עכשיו רק בעיצוב אחר שזה יהיה אופציה שלנו וגם שישפר את האתר זה לא הגיוני אני רוצה משהו מקצועי לא חרא"
- Marshal console = the "מסלול" tab (landing page). Sticky top bar: state chip (ממתין/רץ/עצור/הסתיים), heat, clock, and
  three big buttons:
  - התחלה: starts the called/next heat; on a stopped heat it reads "המשך" and resumes.
  - עצור: pauses the heat on track (LiveRun.pausedAt). Clock and simulated laps freeze.
  - שמור: ends the heat into history (finishRun) and calls the next queued heat.
  The venue screen carries the same three buttons at its TOP (hideable).
- Name editing inline (NameEditor): next heat = names + karts; during the race = names only (karts locked).
- Nameless heat: "התחל עכשיו בלי שמות" (quickStartHeat) creates a heat of N drivers and puts it on track at once;
  drivers show as "נהג 1..n" until names are typed in (also during the race). Closed while the cashier add-on is on.
- Professional shell: compact app bar (logo, "מערכת זמנים", סימולציה badge, on-air chip), flat dark surfaces, timing
  tables (marshal + history) with tabular figures, wide two-column console on desktop (table | quick start, queue,
  screen + collapsed demo tools).
- STILL OPEN (owner to confirm): "שזה יאסף במסלול" - whether laps should be captured automatically on the track even
  without names. Not designed for: lap times remain SIMULATED; no hardware capture is claimed.
- Tests: 24 (22 previous unchanged + marshal start/stop/save + nameless quick start).

## Product hierarchy (gen 4): TIMING IS THE CORE, the cashier is an optional add-on
Owner, verbatim: "אני רוצה שהמערכת תיהיה הזה של הזמן עם הכפתורים וההיסטוריה והאתר והזה של הקופה יהיה רק תוסף".
- Core (always on): tabs "מסלול" (default; queue + quick "new heat" + venue screen), "מקצים", "היסטוריה", "הגדרות".
- Cashier add-on: Settings -> "תוספים" -> "תוסף קופה" כבוי/פעיל (settings.cashierEnabled, OFF by default). When ON, the
  "קופה" and "הרשמה" tabs appear after the core tabs.
- Without the cashier: track staff add a heat by driver count (addTrackHeat, 1..capacity) straight into the queue; names
  and karts are edited afterwards ("שמות וקארטים"). Such groups are origin 'track' and cleared to race; no payment concept.
- With the cashier ON, addTrackHeat (and the core demo) is CLOSED, so every group must pass the cashier's pending -> "שולם"
  confirmation. The payment gate is unchanged (planHeats/addToHeat/approveHeat/queueOf/call-up/start all check it).
- Board controls (generic, minimal, on the venue screen itself): "קרא למסלול · מקצה N", "התחל מקצה N" (disabled with the
  blocker reason), "בטל קריאה", during the race "סיים מקצה ושמור", after the finish "שמור ועבור למקצה הבא" (save + call the
  next queued heat), and "הסתר כפתורים" (a small ⚙ brings them back) for a public screen.
  Deliberately NOT built: timed heats (10/20 min), ticket types, prices, mixing rules - not confirmed.
- One-click demo: without the cashier it uses demoTrackSetup (synthetic heats, no registrations); with it, demoSetup.
- Tests: 22 (19 previous unchanged + timing core without cashier, track entry closed while cashier ON, core demo).
- Layout: the control bar is inside the fitted screen; all fit checks pass with it. With 14 karts at 1280x720 rows are
  ~30px (small text for a 720p TV across the room); hiding the controls gives that space back.

## Payment gate (repair round, gen 2)
- Every entry path needs an explicit cashier "שולם" before queue admission: customer form, cashier manual add (now a PENDING
  submission by headcount, source 'cashier'), and "load demo registrations" (pending, source 'demo').
- Durable state: Group.paid (+ paidAt). Set only by markPaid (submission) or confirmGroupPaid (explicit button).
  addGroup is a low-level constructor and always creates an UNPAID group.
- Checked downstream: planHeats and addToHeat skip/refuse unpaid; approveHeat and revalidate require heatPaid; queueOf excludes
  any heat with an unpaid group, so callHeat / screenState (call-up) / startHeat can never reach it; startBlockers explains why.
- The one-click auto-demo creates its OWN demo submissions and confirms only those; pre-existing pending submissions are untouched.
- Saved data from before the gate: migrateCore on load; a group without the flag is paid only if a paid submission produced it,
  otherwise it shows under "קבוצות בלי אישור תשלום" with a "שולם" button.
- Tests: 19 cases (payment-gate regressions included). Older tests now confirm payment explicitly in their setup; the legacy-data
  test now asserts an unpaid legacy heat stays off the call-up screen until confirmed.

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
- Persistence: device-local only (useLocalState). There is no shared backend, so a separate venue-screen device cannot follow along yet. The track screen is an overlay on the same device.
- Queue order follows heat numbers. There is no drag-reorder; the cashier can call any queued heat out of order instead.
- Logo: official wide logo (owner-verified URL on dankart.co.il) downloaded once and bundled as public/dan-karting-wide-logo.png; the app makes no external calls. Shown on a light plate because its tagline is black.

## Known gotchas
- Avoid dynamic native <select>: it crashed the hosted app (DOM removeChild). Only buttons and chips are used.
- '@instinct/files' API is mirrored by the shim from usage only. Check it against the real package on delivery.

## Screens fit the whole heat (repair round, gen 2)
- Lineup and live board measure their free space (ResizeObserver) and size cards / rows so the whole heat fits with no scroll,
  checked at 390x844, 1280x720 and 1920x1080 for 10 and 14 karts. Names wrap (never truncated); long names get a taller strip.
- Row height is capped (phone 52px, desktop <1400px wide 64px, wider 84px), so a small field (2-3 karts) does not stretch;
  fixed-height rows subtract the 3px row gaps. Font follows the row height AND the 7.5vw time column, and every timing
  number (sectors, last, best, gap, laps) is white-space:nowrap, so digits never break onto a second line (gen 3).
- Lap gaps are structured ({laps}|{ms}); the signed number is an isolated LTR run so "+1" never flips or overlaps in RTL.
- The phone "00:00" frame is the estimated countdown reaching zero on the final lap, before the chequered flag: expected.

## Project skill
- .claude/skills/04-reverse-engineering/SKILL.md: owner-supplied reverse-engineering reference for future AMB decoder protocol work.
  Knowledge only: its Python dependencies and shared plugin utilities are NOT installed.
