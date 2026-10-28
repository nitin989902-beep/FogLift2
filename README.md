# FogLift

An anonymous, real-time "I'm lost" signal for classrooms. Students tap one button on their phone; the teacher sees a live confusion graph and gets a report showing which topics caused the most trouble.

## Run it

Requires Node.js 16 or newer. There is nothing to install.

```
node server.js
```

1. Open `http://localhost:3000/teacher` on the teacher's laptop and start a session.
2. Students on the same Wi-Fi scan the QR code (or open the address shown and type the 4-character code).
3. Teach. Add topic markers as you move between topics.
4. Press **End class and see report**.

The QR code library and the font load from the internet. Without internet the app still works; students just type the code instead of scanning.

Change the port with `PORT=4000 node server.js`.

## Features

- Anonymous one-tap "I'm lost" and "Got it" buttons (one tap per type every 20 seconds per phone)
- Live graph of the percentage of the class that is lost, updated every 5 seconds
- Flashing alert and optional sound when the lost share passes a threshold you set
- Topic markers that label the graph and the report
- End-of-class report: most confusing topics, confusion spikes with the topic at the time, CSV download, print to PDF
- Join by QR code or 4-character code; the join link uses the laptop's Wi-Fi address automatically

## How it works

**Who counts as lost.** A student counts as lost if their most recent tap in the last 60 seconds was "I'm lost". Tapping "Got it" clears them, so the graph drops as the fog lifts. The percentage is lost students divided by connected students.

**Alert rule.** An alert fires when the lost share reaches the threshold (default 30%) and at least 2 students are lost, so one confused student never triggers it.

**Anonymity.** Each phone stores a random ID in its own browser, used only to enforce the tap cooldown and count connected students. The teacher's dashboard receives totals only. Nothing is written to disk; all data lives in server memory and disappears when the server stops.

**Real-time updates.** The server pushes updates to browsers with Server-Sent Events (SSE), so the project needs no WebSocket library.

## Architecture

```
Student phone ──POST /tap──────────►  Node.js server (in-memory sessions)
Student phone ◄──SSE (session state)─┤        │ samples every 5 s
Teacher page  ◄──SSE (live state)────┘        ▼
Teacher page  ──POST marker/threshold/end─►  history[] + taps[] + markers[]
Teacher page  ──GET report─────────────────► spikes + per-topic stats
```

| File | Purpose |
|---|---|
| `server.js` | HTTP server, session store, confusion maths, SSE, report builder |
| `public/index.html` | Landing page, student join by code |
| `public/student.html` | Student view: lamp button, got-it button, cooldown |
| `public/teacher.html` | Setup, live dashboard, chart, markers, report |
| `public/style.css` | Shared styles, light and dark mode |

## API

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/api/session` | teacher | Create a session; returns `code` and secret `token` |
| GET | `/api/session/:code/public` | anyone | Title and whether the class has ended |
| GET | `/api/session/:code/stream` | both | SSE stream (`role=student` or `role=teacher&token=...`) |
| POST | `/api/session/:code/tap` | student | Send `lost` or `gotit` |
| POST | `/api/session/:code/marker` | teacher | Add a topic marker |
| POST | `/api/session/:code/threshold` | teacher | Change the alert threshold |
| POST | `/api/session/:code/end` | teacher | End the class |
| GET | `/api/session/:code/state` | teacher | Current snapshot |
| GET | `/api/session/:code/report` | teacher | Full report |

## Testing done

Checked with scripted requests: session creation, taps from multiple devices, 20-second cooldown (HTTP 429), teacher-only endpoints rejecting a wrong token, markers, "Got it" lowering the count, ending a class, tapping after the end (HTTP 410), and report spikes labelled with the right topic.

## Limitations and ideas for extension

- Data is kept in memory only; add SQLite to keep a semester of history and compare topics across lectures.
- Any phone that knows the code can join. Adding a teacher-controlled "lock class" switch would stop outsiders.
- Cooldowns are per phone, so a determined student could clear their browser storage to tap more often. A per-IP limit would reduce this.
- A "confusion heatmap by slide" view would be possible if the teacher's slide changes were captured.
