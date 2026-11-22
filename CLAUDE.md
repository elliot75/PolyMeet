# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development commands

Use Node.js 20.19+ on the Node 20 line, or 22.12+ on newer supported lines. Run commands from the repository root.

| Command                                     | Purpose                                                                                                                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                                    | Install the locked dependencies for a fresh checkout.                                                                                                                                          |
| `npm run dev`                               | Start Vite on `127.0.0.1:5173` and the Hono proxy on `127.0.0.1:3001`. Port 5173 is strict. Vite proxies `/api` and `/ws` to port 3001, so keep the backend `PORT` at 3001 during development. |
| `npm run dev:client` / `npm run dev:server` | Run either development process independently.                                                                                                                                                  |
| `npm run typecheck`                         | Check client, server, and shared TypeScript.                                                                                                                                                   |
| `npm test`                                  | Run the Vitest suite without live provider credentials.                                                                                                                                        |
| `npm test -- tests/wsAdapters.test.ts`      | Run one test file. Add `-t 'Gemini finals'` to select a test by name.                                                                                                                          |
| `npm run format:check` / `npm run format`   | Check or apply Prettier formatting.                                                                                                                                                            |
| `npm run build`                             | Type-check, build the Vite client, and bundle the Node entry point with esbuild.                                                                                                               |
| `npm start`                                 | Serve the built client and proxy together on `127.0.0.1:3001`. `npm run preview` runs the same command.                                                                                        |

Browser settings support separate OpenAI/Gemini selections for live transcription, file transcription, translation, and minutes. Browser-supplied keys take precedence over optional server fallbacks (`OPENAI_API_KEY` and `GEMINI_API_KEY` in `.env`, see `.env.example`). Providers are only needed for AI operations. `GET /api/health` reports fallback key availability as booleans. `README.md` documents recording, recovery, and browser limitations. `PLAN.md` describes the original requirements and proposed layout.

## Architecture

- **Workspace and storage.** `src/client/App.tsx` coordinates meeting selection, recording lifecycle, persistence, and projection. `src/client/db/meetingDb.ts` owns the versioned IndexedDB schema for meetings, recordings, ordered audio chunks, transcripts, and minutes. The backend is stateless. Preferences live in local storage, with API keys scoped to session storage by default.
- **Live audio.** `App.tsx` manages microphone and display capture and saves periodic `MediaRecorder` chunks. `src/client/audio/liveCapture.ts` starts a separate `public/audio-worklet.js` and `LiveSttClient` per microphone/system track. The worklet resamples to PCM16 and detects speech boundaries. The client queues audio during reconnect and drains pending audio on stop. `src/shared/protocol.ts` defines the browser/proxy wire events. `src/server/ws/sttProxy.ts` owns the upstream connection lifecycle, while `adapters.ts` maps provider events and accounts for their different VAD and finalization behavior.
- **File transcription and text generation.** `TranscriptFeed.tsx` coordinates file upload, the browser chunker, and recording-relative segment timestamps. `translationQueue.ts` schedules bilingual translation with recent context. `MinutesStudio.tsx` generates and stores editable versions. `apiClient.ts` reads SSE responses from the translation and minutes endpoints. `src/server/app.ts` defines health, model discovery, file transcription, and SSE routes. Provider output handling lives under `src/server/providers/`, with Chinese script conversion in `src/server/language.ts`.
- **Server entry and tests.** `src/server/index.ts` attaches both Hono and the `/ws/stt` upgrade handler to the same loopback HTTP server. HTTP and WebSocket paths share origin validation. Tests in `tests/` exercise the Hono app and provider adapters with mocks, and use `fake-indexeddb` for persistence. Shared model defaults and capability hints live in `src/shared/models.ts`.
