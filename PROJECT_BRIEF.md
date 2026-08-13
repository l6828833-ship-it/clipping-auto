# ShortsPro AI — Full Project Explanation

## Overview

ShortsPro AI is a full-stack SaaS web application that turns long-form videos into viral short-form clips (TikTok, Reels, YouTube Shorts). Users upload a video or paste a YouTube URL, and the AI detects engaging moments, generates 9:16 vertical clips with animated word-level subtitles, and exports them ready to post.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite 6, TypeScript 5 |
| Styling | Tailwind CSS v4, CSS custom properties, tw-animate-css |
| UI Components | Radix UI primitives, shadcn/ui pattern (CVA + clsx + tailwind-merge) |
| Routing | wouter (lightweight React router) |
| State/API | tRPC (end-to-end typesafe API), @tanstack/react-query |
| Backend | Express.js with tRPC adapter, Node.js |
| Database | MySQL 8 with Drizzle ORM |
| Auth | Custom JWT auth (bcryptjs for password hashing, jose for JWT signing) |
| Icons | lucide-react |
| Toasts | sonner |
| Package Manager | npm (originally pnpm) |

---

## Project Structure

```
shortspro-ai/
├── client/                  # Frontend (Vite root)
│   ├── index.html           # Entry HTML (loads fonts)
│   ├── public/              # Static assets
│   └── src/
│       ├── App.tsx          # Router + providers
│       ├── main.tsx         # React DOM entry
│       ├── index.css        # Design system (CSS variables, utilities)
│       ├── const.ts         # Re-exports from shared
│       ├── _core/           # Auth/session plumbing
│       ├── components/
│       │   ├── AppLayout.tsx       # Main dashboard layout (sidebar + header + content)
│       │   ├── ClipTimeline.tsx    # Advanced clip timeline editor
│       │   ├── ClipPreview.tsx     # Video clip preview player
│       │   ├── VideoFramer.tsx     # Crop/zoom/pan reframing UI
│       │   ├── SubtitleOverlay.tsx # Word-level subtitle preview
│       │   ├── MusicPlayer.tsx     # Background music controls
│       │   ├── AIChatBox.tsx       # AI interaction UI
│       │   ├── ErrorBoundary.tsx   # Error fallback
│       │   └── ui/                 # shadcn/ui component library (50+ components)
│       ├── contexts/
│       │   └── ThemeContext.tsx    # Light/dark theme provider (switchable)
│       ├── hooks/
│       │   ├── useCustomAuth.ts   # Auth hooks (useRequireAuth, useRedirectIfAuth)
│       │   └── useInworldKey.ts   # API key access hook
│       ├── lib/
│       │   ├── trpc.ts           # tRPC React client
│       │   ├── utils.ts          # cn() utility (clsx + tailwind-merge)
│       │   └── videoSource.ts    # YouTube URL parsing, thumbnail helpers
│       └── pages/
│           ├── Home.tsx           # Landing page (marketing/hero)
│           ├── Login.tsx          # Auth: login
│           ├── Register.tsx       # Auth: register
│           ├── Dashboard.tsx      # Main dashboard (stats, recent videos, quick actions)
│           ├── Create.tsx         # Multi-step clip creation wizard (5 steps)
│           ├── VideoInput.tsx     # Video upload / URL input
│           ├── Highlights.tsx     # AI highlight detection page
│           ├── Clips.tsx          # Clip list + advanced editor (framing, subtitles, music)
│           ├── SubtitleEditor.tsx # Standalone subtitle styling
│           ├── Top5Reels.tsx      # Top 5 Reels builder
│           ├── InworldModels.tsx  # AI model configuration (Inworld API)
│           ├── Profile.tsx        # User profile + password change
│           └── NotFound.tsx       # 404 page
├── server/                  # Server source (stub — full server is pre-compiled)
│   └── routers.ts           # Type stub for AppRouter (used by tRPC client)
├── shared/                  # Code shared between client and server
│   ├── const.ts             # Constants (cookie name, error messages, OAuth helpers)
│   └── framing.ts           # Video framing/crop math (segments, easing, interpolation)
├── drizzle/                 # Database schema and migrations
│   ├── schema.ts            # Full schema (users, videos, clips, subtitles tables)
│   ├── relations.ts         # Table relations
│   └── migrations/          # SQL migration files
├── dist/                    # Pre-compiled production bundle
│   ├── index.js             # Full server bundle (Express + tRPC + all routes)
│   └── public/              # Built frontend assets
├── assets/
│   └── fonts/               # Caption fonts for video rendering
├── .data/                   # Runtime data (video files, rendered clips)
│   ├── clips/               # Rendered clip output
│   └── videos/              # Hosted video files
├── .env                     # Environment variables
├── package.json             # Dependencies and scripts
├── vite.config.ts           # Vite config (aliases, proxy, build)
├── tsconfig.json            # TypeScript config
├── drizzle.config.ts        # Drizzle ORM config (MySQL)
└── components.json          # shadcn/ui config
```

---

## Design System

The app uses a **warm light theme** (default) inspired by Pocket Archive, with a **switchable dark mode**.

### Light Mode (Default)
- Background: `#fbfaf6` (warm off-white)
- Foreground: `#242422` (near-black)
- Cards: `#ffffff` with subtle border `#e8e6e1`
- Primary action: `--cobalt` (#315ef5) — cobalt blue
- Accent colors: `--coral` (#dd7d71), `--mint` (#59a485), `--amber` (#f1cb67)
- Fonts: "DM Sans" (body), "IBM Plex Mono" (monospace/labels)
- Sidebar: `#fcfbf9` with light border

### Dark Mode
- Background: `#0f0f0e`
- Foreground: `#f2f1ed`
- Cards: `#1a1a18` with border `#2e2e2b`
- Brand colors are lightened for contrast (e.g., cobalt → `#5b82f7`)
- Sidebar: `#121211`

### Utilities
- `.glass` — card with border + subtle shadow (theme-aware)
- `.ink-button` — solid dark pill button (inverts in dark mode)
- `.gradient-text` — cobalt-to-mint gradient text
- `.glow-blue`, `.glow-green`, `.glow-pink` — subtle glow shadows
- `.status-pending/processing/done/error` — colored status badges
- `.eyebrow` — uppercase mono label
- `.animate-fade-in`, `.animate-slide-up`, `.animate-scale-in` — entry animations

---

## Authentication

- **Custom email/password auth** (no OAuth dependency for local dev)
- Passwords hashed with bcryptjs
- Sessions via JWT stored in HttpOnly cookie (`app_session_id`)
- tRPC procedures: `auth.me`, `auth.login`, `auth.register`, `auth.logout`
- Client hooks: `useRequireAuth()` (redirects to login if unauthenticated), `useRedirectIfAuth()` (redirects to dashboard if logged in)

---

## Database Schema (MySQL + Drizzle ORM)

### `users`
- id, openId (unique email-based), name, email, passwordHash, role (user/admin), timestamps

### `videos`
- id, userId, title, sourceType (upload/url), sourceUrl, status (pending/transcribing/analyzing/done/error)
- duration, transcript, transcriptWords (word-level timing JSON)
- hostedStatus (none/downloading/ready/error), hostedUrl, hostProgress
- width, height, transcriptionEnabled, sttCalls, sttSeconds

### `clips`
- id, videoId, userId, title, startTime, endTime, engagementScore
- status (pending/rendering/done/error), downloadUrl, thumbnailUrl
- zoom, offsetX, offsetY (reframing), framingSegments (JSON — animated crop keyframes)
- captionsEnabled, music (JSON), scale, barColor, textOverlays (JSON)

### `subtitles`
- id, clipId, userId, words (JSON — word-level timing), style (JSON — font, size, color, position)

---

## Key Features

1. **Video Import** — Upload MP4/MOV or paste YouTube URL; server downloads and hosts locally
2. **AI Highlight Detection** — Analyzes transcript to find viral moments with engagement scoring
3. **Multi-step Create Wizard** — 5-step flow: Input → Highlights → Subtitles → Edit → Export
4. **Clip Timeline Editor** — Advanced multi-track timeline (framing, captions, music, text overlays)
5. **Video Reframing** — Interactive crop/zoom/pan for 9:16 vertical format with keyframe animation
6. **Word-level Subtitles** — Animated captions with customizable font, color, highlight, position
7. **Background Music** — Add music tracks with volume control and ducking
8. **FFmpeg Rendering** — Server-side clip rendering with burned-in subtitles
9. **Top 5 Reels** — Batch clip generation workflow
10. **AI Models (Inworld)** — Integration with Inworld AI for highlight detection and scripting

---

## API Architecture (tRPC)

The API uses tRPC with Express adapter. Endpoints are grouped by domain:

- **auth** — me, login, register, logout
- **profile** — get, update, changePassword
- **videos** — list, get, create, updateStatus, releaseHosted, delete
- **clips** — list, listByVideo, create, updateStatus, delete
- **subtitles** — get, save
- **extract** — videoInfo, transcribe, uploadTranscribe
- **gemini** — models, detectHighlights

---

## Running Locally

### Prerequisites
- Node.js 20+
- MySQL 8 running on localhost:3306

### Environment (.env)
```
DATABASE_URL=mysql://root:12345678@localhost:3306/shortspro
JWT_SECRET=local-dev-secret-change-me-in-production
PORT=3000
```

### Commands
```bash
# Install dependencies
npm install --legacy-peer-deps

# Push database schema
npx drizzle-kit push

# Start the API server (pre-compiled)
node dist/index.js

# Start Vite dev server (frontend with HMR + proxy to API)
npx vite --host --port 5173
```

- Frontend: http://localhost:5173/
- API: http://localhost:3000/api/trpc/*
- The Vite dev server proxies `/api` requests to the backend on port 3000.

---

## Routes

| Path | Page | Auth Required |
|------|------|:---:|
| `/` | Landing page (Home.tsx) | No |
| `/login` | Login | No (redirects if logged in) |
| `/register` | Register | No (redirects if logged in) |
| `/dashboard` | Main dashboard | Yes |
| `/dashboard/create` | Multi-step create wizard | Yes |
| `/dashboard/top5-reels` | Top 5 Reels builder | Yes |
| `/dashboard/inworld-models` | AI model config | Yes |
| `/dashboard/highlights` | AI highlight detection | Yes |
| `/dashboard/clips` | Clips list + editor | Yes |
| `/dashboard/subtitle-editor` | Subtitle styling | Yes |
| `/dashboard/profile` | User profile | Yes |
| `/dashboard/video-input` | Video upload/URL input | Yes |

---

## Notes for Development

1. **Server source is missing** — Only `dist/index.js` (compiled bundle) exists. The `server/routers.ts` is a type stub. If you need to modify server logic, you'll need to decompile or rewrite routes.

2. **Theme toggle** — Stored in localStorage as `"theme"`. The `.dark` class is added to `<html>` element.

3. **tRPC client** — Located at `client/src/lib/trpc.ts`. The AppRouter type is `any` (stub) so you won't get full type inference without the server source.

4. **Shared code** — `shared/const.ts` and `shared/framing.ts` are used by both client and server. The framing module contains all the math for animated crop segments.

5. **Video files** — Stored in `.data/videos/` and `.data/clips/`. These directories are gitignored.

6. **Fonts** — Caption fonts in `assets/fonts/` must match what the server uses for rendering burned-in subtitles.
