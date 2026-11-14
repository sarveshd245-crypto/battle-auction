# BATTLE AUCTION 2.0 — Starter Project

This ZIP contains a runnable early-stage multiplayer auction foundation. It is deliberately labelled as a starter build: it does **not** claim that every item in the full specification is already implemented.

## Included now
- Responsive dark fantasy game UI.
- Create/join room flow for 2–10 players.
- Server-managed room state and turn deadlines.
- One-character-at-a-time auction.
- Per-turn increase-by-custom-amount or skip.
- A skipped player can bid again on their next turn.
- Fixed turn timer; a bid does not extend the timer.
- Auction resolves after a complete cycle of no increases after the last bid.
- Budget and team-size validation.
- Random character shuffle at the start of each game; same shuffled order is broadcast to all players in that room.
- Small seed character set for trying the auction flow.
- Server-side Gemini API research endpoint scaffold.
- PostgreSQL schema starter.

## Not yet complete
The following full-specification features require further implementation and testing:
- Persistent PostgreSQL integration (the current live room state is in server memory).
- Reconnection/session identity and room restoration.
- Full character database import, approval workflow and reliable web-search grounding.
- Gemini-powered structured character research with source verification.
- Full character ratings methodology and canonical-version review tools.
- Gemini matchup/counter/synergy analysis.
- Complete round-robin championship engine and final ranked leaderboard.
- Production-grade authentication, authorization, rate limiting and deployment hardening.
- Extensive automated and end-to-end tests.

## Requirements
- Node.js 20 or newer
- npm

## Run locally
1. Extract this ZIP.
2. Open a terminal in the extracted `battle-auction` folder.
3. Run `npm install`.
4. Copy `.env.example` to `.env`.
5. Optionally add your Gemini API key to `GEMINI_API_KEY` in `.env`.
6. Run `npm run dev`.
7. Open the Vite URL shown in the terminal (usually http://localhost:5173).

For a single-process production-style run:
1. Run `npm run build`.
2. Run `npm start`.
3. Open http://localhost:3000.

## Gemini research endpoint
`POST /api/research` with JSON:
```json
{ "universe": "Bleach" }
```
The endpoint uses the Google Generative AI SDK on the server. This is a research draft only. The response must be checked against reliable sources and approved by the host before insertion into the permanent character database. This endpoint by itself is not a full web-grounded research pipeline.

## Deployment
Set `GEMINI_API_KEY` and other secrets as server-side environment variables in your hosting provider. Never commit `.env` or expose the key to browser code. Configure a managed PostgreSQL database before enabling persistent game data.

## Important
- Virtual in-game currency only; no real-money wagering.
- Character images are represented by stylised placeholders in this starter build. Add only artwork you have rights to use.
- The initial sample character list is deliberately small and illustrative, not a complete or independently verified canon database.
