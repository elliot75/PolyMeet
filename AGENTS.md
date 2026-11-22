# Repository Guidelines

## Project Structure

PolyMeet is a React 19/Vite client and a Hono/Node proxy. `src/client/` contains components, audio capture, IndexedDB persistence, and services. `src/server/` contains HTTP routes, provider integrations, and WebSocket adapters. Shared types and messages live in `src/shared/`; the standalone audio worklet is in `public/`. Tests are in `tests/`. Consult `PLAN.md` for the architecture and `README.md` for setup and known recording limitations.

## Development and Build

- `npm install` installs dependencies; Node.js 20.19+ or 22.12+ is required.
- `npm run dev` starts Vite on port 5173 and the local proxy on port 3001.
- `npm run typecheck` checks client, server, and shared TypeScript.
- `npm test` runs the Vitest suite without live provider credentials.
- `npm run build` builds the client and bundles the server; `npm start` serves the result locally.
- `npm run format` formats the source and tests; `npm run format:check` checks formatting.

## Coding Style and Tests

Use TypeScript and React function components. Prettier enforces two-space indentation, single quotes, and a 100-column print width. Use camelCase for functions and variables, PascalCase for components and types, and follow existing filenames. Keep provider-specific logic behind server adapters and shared contracts in `src/shared/`.

Name tests `*.test.ts` or `*.test.tsx`. Add focused coverage for protocol changes, audio conversion, persistence, and routes. Use `fake-indexeddb` for browser storage and mock provider services; routine tests must not require real API keys. Verify UI changes at narrow and desktop widths.

## Commits, Pull Requests, and Configuration

Git history is unavailable in this checkout. Use short imperative commit subjects, such as `Add IndexedDB recovery flow`. Pull requests should explain behavior and architecture changes, list checks performed, link relevant issues, and include screenshots for UI changes.

Never commit API keys or real `.env` files. Document variable names in `.env.example`; browser-supplied keys take precedence over server fallback keys. Do not log keys, raw audio, or private transcripts. The server listens on loopback and must validate request origins.
