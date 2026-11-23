# Impostor

A pass-and-play social deduction party game for one phone. Most players see a secret word. The impostor sees the category, a shared target, a hint, and (with 7+ players) their fellow impostor.

## Run locally

The site fetches `data/words.json`, so serve the folder over HTTP instead of opening `index.html` directly:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Rules

- **4–6 players:** 1 impostor
- **7+ players:** 2 impostors
- Impostors know each other and share one target, always an innocent player.
- Innocents see the category and secret word.
- Impostors see the category, shared target, fellow impostor (if any), and one hint.
- Hints cycle through each word’s 2–3 hints when that word is reused.

### Scoring

| Outcome | Points |
| --- | --- |
| At least one impostor voted out | Each innocent +5; all impostors 0 |
| No impostor voted out, target survives | Each impostor +15 |
| Shared target voted out | Each impostor +30 instead of 15 |
| Round skipped | No points; no streak/cooldown changes |

Scoring is team-based. With two impostors, if one is caught, neither gets the survival bonus.

### Impostor limit

- A player can be the impostor twice in a row.
- After the second consecutive round, they sit out two played rounds.
- Skipped rounds do not count toward streaks or cooldowns.

## Development

No build step and no runtime dependencies. The app uses plain ES modules, HTML, and CSS.

```text
index.html
styles.css
app.js
game.js
data/words.json
tests/game.test.mjs
```

Run the logic tests with Node 20+:

```bash
npm test
```

If Node is not installed, the game itself still runs in any modern browser.

### Adding categories or words

Edit `data/words.json`:

```json
{
  "categories": [
    {
      "id": "food-drink",
      "name": "Food & Drink",
      "words": [
        { "word": "Pizza", "hints": ["cheese", "Italy", "slice"] }
      ]
    }
  ]
}
```

Every word needs 2–3 short hints. Category settings update automatically from this file. Keep at least one word in every category.

## Deploy to GitHub Pages

1. Create a GitHub repository and push these files to the `main` branch.
2. Open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Select the `main` branch and the **`/ (root)`** folder, then save.
5. The game will be available at `https://<username>.github.io/<repo>/`.

The included `.nojekyll` file keeps GitHub Pages from processing the site with Jekyll.

## Notes

- All game state and settings are stored in `localStorage` on the device.
- There is no backend, account, analytics, or network request beyond loading `data/words.json`.
- The game has no automatic winner screen. The scoreboard appears after every round, and the reset button in the header starts a new game while keeping player names and category settings.
