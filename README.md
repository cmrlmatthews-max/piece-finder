# Piece Finder

## What it does

Piece Finder helps two people finish a 1500-piece jigsaw puzzle.

It is a web app: a website that works like an iPhone app.

Loose piece: a piece that is not placed in the puzzle yet.

Photograph small, sorted groups of loose pieces from above.

The app finds each piece in the photo and saves it.

To fill an empty spot, photograph the spot, pick it on the poster, or use both.

Poster: a picture of the finished puzzle, such as the picture on the box.

Claude: an AI model from Anthropic.

The app sends photos to Claude.

Contact sheet: a grid of numbered piece photos.

The app builds contact sheets. Claude reads them and ranks the pieces that could fit.

The app circles the best candidates on the group photos.

Tap **Placed ✓** when you place a piece. The app then removes that piece from the loose pieces.

## Files

The repo root holds these files.

- `index.html`: the app page.
- `app.css`: the app styles.
- `app.js`: the screens and the search steps.
- `imgutil.js`: loads, resizes, and crops photos.
- `db.js`: saves groups, pieces, the poster, and settings on the phone.
- `segment.js`: finds the loose pieces in a group photo.
- `sheet.js`: builds contact sheets and draws circles on photos.
- `api.js`: sends photos to Claude and reads the answer.
- `poster.js`: the screen where you pick the spot on the poster.
- `manifest.webmanifest`: the app name, colors, and icons for the Home Screen.
- `icons/`: the app icons.
- `tests/`: test scripts and test photos.
- `SPEC.md`: the build spec for the app.
- `README.md`: this file.

## Set up GitHub Pages

GitHub Pages: a free GitHub service that puts a web page online.

Repository (repo): a project folder stored on GitHub.

Follow these steps to put the app online.

1. Sign in to GitHub as cmrlmatthews-max.
2. Open https://github.com/new.
3. Type piece-finder in the **Repository name** box.

> **Caution:** GitHub Pages needs a public repository on a free account.

4. Select **Public**.
5. Click **Create repository**.
6. Click **uploading an existing file**.

> **Caution:** Upload the files inside the project folder. Do not upload the folder itself.

7. Drag the files and folders inside the project folder into the upload box.
8. Scroll to the bottom of the page.
9. Click **Commit changes**.
10. Click **Settings**.
11. Click **Pages** in the left menu.
12. Open the **Source** list and select **Deploy from a branch**.
13. Open the **Branch** list and select **main**.
14. Open the folder list and select **/ (root)**.
15. Click **Save**.
16. Wait one to two minutes.
17. Open https://cmrlmatthews-max.github.io/piece-finder/.

## Get a Claude API key

API key: a password that lets the app use Claude.

1. Open https://console.anthropic.com/.
2. Sign in.
3. Open **API Keys**.
4. Click **Create Key**.
5. Name the key piece-finder.

> **Caution:** The key appears only once. Copy it before you leave the page. Do not send the key to other people.

6. Copy the key.
7. Open https://cmrlmatthews-max.github.io/piece-finder/ in Safari.
8. Tap **Settings** at the bottom of the screen.
9. Paste the key into the **API key** box.
10. Tap **Test key**.
11. Look for the message **Key works**.
12. If an error appears, paste the key again.

## Add to iPhone Home Screen

> **Caution:** Use Safari for these steps.

1. Open https://cmrlmatthews-max.github.io/piece-finder/ in Safari.
2. Tap the **Share** button. It is the square with an up arrow.
3. Scroll down.
4. Tap **Add to Home Screen**.
5. Tap **Add**.
6. Open Piece Finder from the Home Screen.

The app opens full screen. It does not show the Safari address bar.

## First use

**Add the poster**

1. Tap **Poster**.
2. Tap **Add poster photo**.

> **Caution:** Keep the phone steady. Blurred photos give poor matches.

3. Photograph the whole poster straight on, in good light.
4. Tap **Use Photo**.

**Add a group of pieces**

1. Tap **Pieces**.
2. Tap **Add group**.

> **Caution:** Keep the pieces apart. Touching pieces may merge into one box.

3. Photograph one sorted group of loose pieces from above.
4. Check that each box covers one piece.
5. If boxes are wrong, move the **Sensitivity** slider.
6. Tap a box that does not cover one piece to delete it.
7. Type a name in **Group name**.
8. Tap **Save group**.

**Search for a piece**

Use a photo of the spot, a spot on the poster, or both. The app blocks **Find pieces** until you add a spot, a group, and an API key.

Photo of the spot:

1. Open the **Find** tab.
2. Tap **Take photo of the spot**.
3. Photograph the empty spot.

Spot on the poster:

1. Tap **Pick the spot**.
2. Tap the empty spot on the poster.
3. Tap **Use this spot**.

Search:

1. Check each group to search.
2. Tap **Find pieces**.
3. Read the ranked list. Rank 1 is the best candidate.
4. Tap **Placed ✓** when you place a piece in the puzzle.
5. Tap **Not it** to hide a candidate that does not fit.
6. Find the circled pieces on the group photos below the list. Tap a photo to see it full screen.
7. If the search used Haiku, tap **Search again with Sonnet**.

## Photo tips

- Use plain white paper or dark cloth.
- Choose a background that contrasts with the pieces.
- Photograph from straight above.
- Use even light. Avoid strong shadows.
- Keep the pieces apart. Do not let them touch.
- Put up to about 36 pieces in each photo.
- Sort the pieces into small groups, such as edge pieces or sky pieces.

## What it costs

Token: a small unit of text. Claude counts tokens to set the price.

Model: the Claude version that reads your photos. Haiku 5.5 is the default. Sonnet 5.5 is smarter and costs more.

Choose a model in **Settings**, under **Model**.

One search sends about 5–7 images to Claude. The images are the spot photo, the poster crop around the spot, and the contact sheets.

With Haiku 5.5, a search costs well under one cent.

With Sonnet 5.5, a search costs a few cents.

The app shows token usage after each search.

## Known limits

- The API key stays on this phone. Do not share the browser data on this phone.
- Searches need an internet connection.
- Pieces that match the background color are missed. Use a contrasting background.
- Results are suggestions, not certainties. Check each piece by eye before you place it.
