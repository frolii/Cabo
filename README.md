# 🦄 Cabo Scorekeeper (PWA)

A mobile-first, 100% offline-capable Progressive Web App (PWA) for tracking scores in the card game **Cabo**.

## ✨ Features

- **Authentic Cabo Theme:** Inspired by the official physical Cabo deck (`0` Unicorn, `1` Feather, `3` Asparagus, `9/10` Spy Glasses, `12` Geometric Swap, `13` Rainbow Glue) with a dark-slate charcoal palette (`#121824`) and vibrant neon-pastel highlights.
- **Game Modes:** Choose between **Standard Mode (100 points)** and **Speed Mode (50 points)**.
- **Automatic Dealer / Starter Rotation:** Automatically rotates the dealer marker to the next player after every round.
- **Automatic "CABO" Call Validation:**
  - If the Cabo caller has strictly the lowest (or tied lowest) card sum, their round score is automatically set to **`0`**.
  - If another player has a lower sum, the **+10 penalty** (`Card Sum + 10` or `Flat +10` variant) is automatically applied.
- **"12-12-13-13" Rule Tracker (Shooting the Moon):** Quick toggle per player when holding both `12`s and both `13`s at the end of a round (`0 pts` for the holder and `+50 pts` to all other players, or `-50 pts` house variant).
- **Exact Threshold Reset ("Kamikaze" Rule):** Hitting *exactly* `100` (or `50` in Speed Mode) resets that player's total to `50` (or `25`) once per game.
- **Full History Editing & Undo:** Tap any completed round in the score matrix to edit or delete it with instant reactive recalculation across all subsequent rounds.
- **100% Offline & Local Persistence:** Auto-saves every change to `localStorage` and `IndexedDB`, and caches all assets via Service Worker (`sw.js`).

## 🚀 Deployment (GitHub Pages / Vercel / Netlify)

No build step or external dependencies are required.

1. Upload all files in this folder to a new GitHub repository.
2. Enable **GitHub Pages** (Settings → Pages → Deploy from `main` branch `/ (root)`), or connect the repository directly to **Vercel** or **Netlify**.
