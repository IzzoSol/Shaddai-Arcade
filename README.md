# ♠ SHADDAI ARCADE — The Hall (blackjack table: Royale)

[![Solana](https://img.shields.io/badge/Solana-Web3.js-9945FF?logo=solana&logoColor=white)](https://solana.com)
[![Node.js](https://img.shields.io/badge/Node.js-Express-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-Realtime-010101?logo=socket.io&logoColor=white)](https://socket.io)
[![Stars](https://img.shields.io/github/stars/IzzoSol/Shaddai-Arcade?style=social)](https://github.com/IzzoSol/Shaddai-Arcade/stargazers)

> **You've got twenty dollars and a dream.** The city doesn't know your name yet — that's about to change. **SHADDAI ROYALE** is a cinematic blackjack come-up saga: climb from cash-only back rooms to the high-roller floor, one sharp hand at a time. Not luck. Nerve.
>
> This repo is becoming **The Hall** — one arcade platform where humans, Shaddai agents, Grok bots, and PayBox agents sit at the same tables. Royale's blackjack is the first live table. See [`docs/ENGINE-VISION.md`](docs/ENGINE-VISION.md) for the platform contract and [`docs/HALL-PHASE1-SPEC.md`](docs/HALL-PHASE1-SPEC.md) for what's shipping now.

*Def Jam: Fight for NY meets a Vegas high-roller saga — part of the [⚡ SHADDAI](https://github.com/IzzoSol) family.*

---

## ✦ What it is

SHADDAI ROYALE is a browser blackjack game wrapped in a **story-mode RPG**. You start at the bottom with $20 and grind up through tiers of the underground — every table a test, every hand a statement — managing your **Royale Bank** chip ledger as the stakes and the storyline escalate. Connect a Phantom wallet for bonus chips, then play the way you want: solo, spectate the agents, run a tournament, or train.

The backend (Node.js + Express + Socket.IO) owns all game state — deck management, hand resolution, splits, doubles, side bets, tournaments — over a REST API with real-time events. The frontend is a single, self-contained neon casino UI. No framework, no build step.

## ✦ Game modes

- **Story Mode** — the come-up. Cinematic beats, escalating tiers, a persistent bankroll, and a narrative that reacts to how you play.
- **Arcade** — solo play vs. the dealer with full casino rules.
- **Agent CPU** — watch 7 SHADDAI AI agents battle the dealer and read their strategies live.
- **Tournament** — a 5-round chip tournament against AI rivals with an accumulating prize pool.
- **Card-Counting Trainer** — learn the count with live feedback.

## ✦ Features

- **7 AI-agent rivals** with distinct playstyles
- **Phantom wallet** connection for bonus chips (Solana)
- **Royale Bank** — persistent chip ledger across sessions
- **Real casino rules** — splits, doubles, side bets, dealer logic
- **Real-time backend** — REST + Socket.IO game state
- **Story Bible engine** — data-driven narrative (`story.js` / `story-mode.js`)
- **Self-contained neon UI** — no framework, no build

## ✦ Run it

```bash
npm install
npm start
# open the served URL (default http://localhost:3000)
```

## ✦ Tech

Vanilla JS frontend · Node.js + Express + Socket.IO backend · Solana Web3.js (Phantom) · zero build step.

---

<div align="center">

**Built by [@IzzoSol](https://x.com/IzzoSol) · Follow [@shaddaiAI](https://x.com/shaddaiAI)** · Part of ⚡ SHADDAI

*The Royale is yours. Don't fold.*

</div>
