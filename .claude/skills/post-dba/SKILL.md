---
name: post-dba
description: Posts a product listing to DBA.dk by driving a real Playwright browser session — creating/resuming a draft, uploading photos, then iteratively discovering and asking the user for each remaining form field (including live dropdown options) until DBA's form is fully filled, then clicking DBA's own preview button. Use when the user asks to post, list, or publish a product to DBA specifically.
---

# Skill: Post product to DBA

Tools: Read and Write on `products.json`; Bash to run `scripts/post_dba.js` commands; AskUserQuestion for each discovered field and the postal code.

## How this works

**Pure UI-driven, no DBA API calls.** DBA's create-item form shows a different set of fields depending on which category is picked — a furniture category has Højde/Bredde/Dybde/Stand, an equipment category (confirmed with a Graef Profi 3060 slicer, resolved to "Erhvervskøkken og restaurant") has none of them — and DBA exposes no API to look up that mapping ahead of time; the category taxonomy lives only in DBA's frontend bundle. Trying to hardcode which fields a category needs is a maintenance trap that goes stale. So instead, `scripts/post_dba.js` discovers the currently-empty fields live from the rendered DOM, one at a time, and re-scans after every fill — because picking one field (e.g. category) can make DBA render brand-new fields that weren't there a moment ago.

Because asking the user what value to put in a field means calling AskUserQuestion in this chat, and a Node script cannot call that tool itself, the script cannot run start-to-finish on its own. It's split into small commands run against one persistent browser session, driven by Claude one step at a time:

```
node scripts/post_dba.js server               # start once, stays running
node scripts/post_dba.js start '<product-json>'
node scripts/post_dba.js scan
node scripts/post_dba.js fill '<field-name>' '<value>'
node scripts/post_dba.js publish
node scripts/post_dba.js stop
```

`server` launches one headed Chromium browser plus a small local HTTP server (127.0.0.1, port written to `.auth/dba-server.port`, gitignored) and idles. Every other command is a short-lived process that sends one HTTP request to that server and prints its JSON response — this is how Claude drives the flow one step at a time across separate tool calls while the same browser tab (and its in-progress, not-yet-saved form state) stays alive throughout.

**The driving loop:**
1. `start` — waits for login, checks DBA's "Mine annoncer" page for an existing draft with a matching title (resumes it if found, otherwise creates a new one), uploads photos, and pre-fills title/description/price/postal code directly (these are already known — no need to ask).
2. `scan` — returns the next empty field it finds on the page, in document order: `{done:false, field:{name, type, options?}}` (a `<select>`'s `options` are its live, current `<option>` text) or `{done:true}`.
3. If not done: ask the user for that field's value — via AskUserQuestion listing `options` when the field is a dropdown, or a plain question for free text — then `fill` it.
4. Repeat from step 2 until `scan` reports `done:true`.
5. `publish` — clicks DBA's own "Se forhåndsvisning" (preview) button and returns. **This is where the script's job ends.** It does not wait for or confirm an actual publish — the user reviews DBA's preview screen and completes the real submit themselves, entirely outside this script's control. There is no listing URL and no published-status confirmation from the script.
6. `stop` — closes the browser.

Login persists across runs the same way as before: after a successful login, cookies/localStorage are saved to `.auth/dba.json` (gitignored, a live session credential — never commit it, never print it). `start` checks this saved session by navigating to DBA's own account page and looking for a login prompt; a stale/expired session still falls through to showing the login overlay.

All user interaction during `start`'s login wait happens through a small status overlay injected into the DBA page itself, not terminal prompts — a terminal `readline` prompt run through an agent's sandboxed shell can leave keystrokes never reaching a background process's stdin, hanging with no visible symptom. The overlay sidesteps that; the field-by-field Q&A itself happens through AskUserQuestion in chat, not the browser.

## Because the script no longer confirms an actual publish

Earlier versions of this script polled a DBA status endpoint until the item left `DRAFT` state, and only then reported success with a listing URL. That polling depended on a DBA API call; going pure-UI removed it, and per explicit product decision, the script's responsibility now ends at clicking the preview button — the actual submit inside DBA's preview screen is the user's job.

This means `channels.dba.status` can no longer be set to `posted` automatically from a script success signal. After `publish` returns, tell the user DBA's preview screen is open and ask them to confirm once they've actually completed publishing there before writing `posted`/`posted_at`/`listing_url` into `products.json` (see Workflow step 9 below).

## Session persistence (posting multiple products)

Login carries over between `server` sessions the same way it did in the previous design — see "How this works" above. Within one `server` process, posting several products in a row only requires the one `start`→...→`publish`→`stop` cycle to repeat; there is no need to restart `server` between products in the same sitting, though `stop` must be called before starting a genuinely new `server` process (only one server can hold the port file / browser at a time).

## Never run two DBA sessions concurrently

DBA's "create a new listing" flow always resumes the one in-progress draft per account rather than minting a fresh item on every visit. Running two `server` processes (or interleaving commands against two products without finishing one first) risks both landing on the same draft and corrupting it — this happened in practice on 2026-08-28 (see `products.json` event history for the Kinnarps/Graef collision). Always run one product's full `start`→`scan`/`fill` loop→`publish`→`stop` cycle before starting the next.

## Known gaps

- Shipping method, listing tier/boost, category-specific attributes beyond what `scan` surfaces as an empty field, and any post-preview steps (payment/checkout screens, etc.) are entirely in the user's hands — the script has no opinion on them and never did, in either design.
- `scan`'s field discovery only finds fields with a discoverable accessible name (a `<label for>`, `aria-label`, or `placeholder`) — a field DBA renders with none of those would be silently skipped rather than surfaced. Hasn't been observed in practice yet.
- There is no automated confirmation that publishing actually succeeded. `channels.dba.status` becomes `posted` only after the user explicitly confirms it (see Workflow step 9).

## Workflow

1. Read `products.json`. Select the requested product(s), or every product with lifecycle `status: "new"` and `channels.dba.status` not `posted` when the user says "all new products". Never post a `sold` product.
2. Validate the product has a non-empty `title`, non-empty `description_da` and `description_en`, a non-negative numeric `price`, and at least one image path that exists on disk. Ask the user for anything missing instead of guessing.
3. Confirm `DBA_SELLER_POSTAL_CODE` is set in `.env` (see `.env.example`). If missing, ask the user for the postal code and write it to `.env` before continuing. Never put it in `products.json`.
4. Show the exact listing payload (title, both descriptions, price, postal code, image paths) for one product and ask the user to confirm before doing anything external.
5. On confirmation, if no `server` is already running for this sitting, start one in the background:
   ```
   node scripts/post_dba.js server
   ```
   This opens a real, visible browser window (needed for login cookies and for the user's own eventual publish click).
6. Run:
   ```
   node scripts/post_dba.js start '<product-json>'
   ```
   passing `{ "title", "description_da", "description_en", "price", "images" }` for the confirmed product as the JSON argument. This waits for login (skipped if a saved session is already valid), resumes or creates the draft, uploads photos, and pre-fills the fields already known.
7. Loop:
   ```
   node scripts/post_dba.js scan
   ```
   - If the response is `{"done":true}`, stop looping and go to step 8.
   - Otherwise it returns `{"done":false,"field":{"name":...,"type":"text"|"number"|"select","options":[...]}}`. Ask the user for a value for that field — use AskUserQuestion with `options` as the choices when `type` is `"select"`; otherwise ask directly for a text/number value. Then run:
     ```
     node scripts/post_dba.js fill '<field-name>' '<value>'
     ```
     and repeat the loop from `scan`. Re-scanning after every fill is required — filling one field (e.g. category) can reveal new fields DBA didn't show before.
8. Once `scan` reports done, run:
   ```
   node scripts/post_dba.js publish
   ```
   This clicks DBA's own preview button. Tell the user DBA's preview screen is now open in the browser and ask them to review it and complete the actual publish themselves, then confirm back once they have (or say if they didn't/won't).
9. Only after the user explicitly confirms they published: update `channels.dba.status` to `posted`, set `channels.dba.posted_at` to the current ISO-8601 UTC time, set the product lifecycle `status` to `posted` if it was `new`, and append a `posted` event with channel `dba` and the `price` the listing was posted at. Ask the user for the listing URL (from DBA's own listing page) if they have it and store it as `channels.dba.listing_url`; otherwise leave it `null`. If the user says they did not publish, do not change `status`/`posted_at`/`listing_url` — append a `post_failed` event instead with a short summary.
10. Write the updated `products.json` after step 9. When posting "all new products", repeat steps 4-9 for each product one at a time — never batch multiple listings into one confirmation — reusing the same `server` process (don't call `stop` between products in the same sitting).
11. Call `node scripts/post_dba.js stop` once done posting for this sitting (last product published/abandoned, or the user is finished).

## Setup this skill depends on

- `scripts/post_dba.js` launches Chromium headed via Playwright and drives DBA's real form/buttons directly for every step — no DBA API calls anywhere in this script. See "How this works" above for the command breakdown.
- `DBA_SELLER_POSTAL_CODE` lives only in `.env` (gitignored), never in `products.json` or chat-derived files. `.env.example` documents the key.
- `.auth/dba.json` (gitignored) holds the saved DBA session — see "Session persistence" above. This is a live credential, functionally equivalent to a password for as long as the session is valid; treat it with the same care as `.env` (never commit, never print its contents, never reference it anywhere persistent outside this file).
- `.auth/dba-server.port` (gitignored) holds the local port the running `server` command is listening on. It's written on `server` startup and removed on `stop`; if a stale file is ever found with no server actually running, `stop`/subsequent commands will fail with a connection error — just delete the file and start a fresh `server`.
- Never record or store login credentials or one-time passcodes anywhere in the repo, skill docs, or scripts. Login always happens by hand during the first pause. When capturing network traffic to debug this flow, scrub any captured login/OTP data before it's referenced anywhere persistent.
- If a run ever appears to hang with no terminal output changing, check the browser window first — the script is very likely waiting on the in-page login overlay, not stuck in the terminal.
