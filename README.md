# Dan Karting heat app (demo)
Phone-first Hebrew RTL web app: customer signup form (group name + participant names) -> simulated payment confirmation at the cashier -> queue, cashier groups, heat planning, simple queue, screen call-up, simulated live timing, history.
Everything is simulated. No venue integration, customer data, prices, payments, safety/age/height rules, vehicle control or spoken announcements.

## Run standalone
    npm install
    npm test          # logic tests (npx tsx tests/logic.test.ts)
    npm run dev       # http://127.0.0.1:5173
    npm run build     # typecheck + production build to dist/

- src/logic.ts  pure logic (planning, cashier overrides, queue/call-up, live run, simulated TimingFeed, ranking, history).
- src/App.tsx   UI. State in device-local storage only (no backend).
- shim/instinct-files.tsx  local stand-in for the hosted '@instinct/files' package (aliased in vite.config.ts and tsconfig.json). In the hosted Files environment the real package is used and App.tsx is unchanged.
- Timing is SIMULATED. A real feed produces Passing[] for lapsFromPassings() (read-only); see docs/TIMING-INTEGRATION.md.
- Venue screens: lineup board (placeholder photos + names) and live timing board. Live tab -> "הדגמה מלאה בלחיצה" runs the whole demo.
- Logo: local copy in public/dan-karting-logo.jpg (cropped from a phone screenshot; replace with the original file for sharper screens).
