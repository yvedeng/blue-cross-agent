---
name: post-dba
description: Posts a product listing to DBA.dk by driving DBA's own recommerce JSON API from an authenticated Playwright session, pausing for the user to log in and to confirm the draft before it publishes. Use when the user asks to post, list, or publish a product to DBA specifically.
---

# Skill: Post product to DBA

Tools: Read and Write on `products.json`; Bash to run `scripts/post_dba.js`; AskUserQuestion for missing fields, the postal code, and the pre-post confirmation.

## How this works

Confirmed by capturing real network traffic (Playwright's request/response recorder) through an actual DBA posting flow (2026-08-27, item id 24370806). DBA's "create listing" UI is a thin client over a stable JSON API — the script talks to that API directly instead of clicking through form fields, which is far more reliable than DOM selectors:

- `GET /recommerce/create/api/user/postalcode` — account default postal code.
- Navigating to `/create-item/start` shows a two-way choice screen — **Markedspladsen** (regular marketplace items) vs **Motor** (vehicles) — and only clicking "Markedspladsen" mints a new item id and redirects to `/recommerce/create/{itemId}`. This script only ever posts regular items, so it always clicks Markedspladsen; there is no vehicle-listing support. This is the only step the script drives via the browser UI rather than the API, since the item id doesn't exist until this click happens.
- `PUT /recommerce/create/api/item/{itemId}/validate` with `{"trade_type":"SELL"}` — creates the draft.
- An initial `PUT /recommerce/create/api/item/{itemId}` draft save (`commit:false`, at minimum `{trade_type, address}`) must happen before the first image upload — calling the image endpoint straight after `validate` with no draft save in between returns HTTP 500 (found by testing, not visible from the original capture's exact request order at a glance — DBA's own flow always does an address-only draft save first).
- `POST /recommerce/create/api/predictions/categories/{itemId}` — DBA's own AI category suggestion based on the item, keyed off title/image. DBA does not expose an API to list the Hovedkategori/Underkategori/Produktkategori dropdown tree — it's baked into DBA's frontend bundle, not fetched over the network, and cascading through it by trial and error (PUTting candidate category ids and reading back `violations`) confirmed there's no shortcut. Replicating that tree in the overlay would mean reverse-engineering and maintaining a copy of DBA's full taxonomy, which would silently go stale. So the script always uses this prediction when DBA returns one (same classifier a human would otherwise approximate by eye) and only falls back to asking the user to pick a category by hand, directly in DBA's real form, when there's no suggestion at all.
- `POST /recommerce/create/api/image/{itemId}?type=<mime>&size=<bytes>` with raw image bytes as the body — returns `{uri, width, height}` to reference in the draft.
- `PUT /recommerce/create/api/item/{itemId}` with `{"commit": false, "data": {...accumulated fields...}}` — saves a draft and returns any remaining `violations` (missing required fields). The same endpoint with `{"commit": true, ...}` is the actual publish call.
- `POST /recommerce/delivery/api/delivery?finnkode={itemId}` with `{"meetup": true, "shipping": false}` — shipping method (currently hardcoded to meetup-only; see Known gaps).
- `GET /my-items/details/{itemId}/api/single?adId={itemId}` — status polling; a freshly published item shows `state.type: "PENDING"` ("Under gennemgang") while DBA reviews it, which is expected and not a failure.

Dimensions (Højde/Bredde/Dybde) and condition (Stand) are always confirmed by the user through an in-page overlay — there is no `products.json` field for them and DBA's condition ids are opaque, so the panel is never skipped. But the script does try to pre-fill height/width/depth by regex-parsing common size patterns out of the product's own `title`/`description` text (e.g. "180 x 90 cm" as a width×depth footprint, "62-128 cm" as an adjustable-height range, taken as its max) before showing the panel — sellers often already state dimensions in the listing copy. This is a best-effort guess shown in editable inputs, never auto-submitted; condition defaults to id 3 ("God, brugt stand", the common case for a used marketplace listing) but is also an editable dropdown. Category is auto-accepted from DBA's own AI suggestion when available, or picked manually in DBA's real form otherwise (see above). Do not add dimension/condition fields to `products.json` on the assumption the script requires them there — the text-parsing guess reads straight from the existing `title`/`description`.

All user interaction happens through a floating panel injected into the DBA page itself, not terminal prompts. A terminal `readline` prompt run through an agent's sandboxed shell can end up with keystrokes that never reach the background process's stdin, leaving it stuck waiting with no visible symptom — the in-page overlay sidesteps that class of bug entirely, since every input is a click or a browser form field the user is already looking at.

## Two-phase design

`scripts/post_dba.js` runs in two phases rather than collecting fields and creating the real listing interleaved:

1. **Discover** (`discoverFields`): creates a throwaway scratch item purely to find out what DBA wants for this product — its AI category suggestion, and whatever the create-item flow requires. Every field is decided here (category auto-accepted or picked manually, dimensions guessed from `title`/`description` text, condition defaulted) before anything about the real listing is touched. The scratch item is deleted (`DELETE /ads/{itemId}`) once discovery finishes.
2. **Fill** (`fillAndPublish`): with every field already decided, creates the real item and fills it in one pass via the API — no more field-collection panels, only a final review panel with Publish/Cancel before the actual `commit:true` call.

This split exists so the user is asked for input up front, in one pass, rather than being interrupted repeatedly while the real listing is half-built. If discovery's scratch draft ever fails to delete (network hiccup), it's left as an abandoned "Kladde" (draft) — harmless, not the published listing.

The discovered fields (`{categoryId, categoryLabel, height, width, depth, condition}`) are printed as a `FIELDS <json>` line on stdout once discovery completes, independent of whether the later publish succeeds — see Workflow step 8 for how the skill persists this into `products.json` as `channels.dba.fields`.

## Known gaps

- The listing-tier/boost step (`POST /recommerce/choose-products/api/ordernow?...productSpecificationUrns=urn:product:package-specification:10`, the free "Basis" tier in the recorded flow) is not called by the script. Items publish successfully without it; revisit if DBA starts requiring an explicit tier choice or the user wants paid boost tiers.
- Shipping is hardcoded to meetup-only (`{"meetup": true, "shipping": false}`). If the user wants to offer shipping, this needs to become a prompt.
- `furniture_brand` and other category-specific attributes beyond dimensions/condition are not collected; DBA's attribute-prediction endpoint exists (`POST /recommerce/create/api/predictions/attributes/{itemId}`) but the script does not currently call it or prompt for extra attributes.

## Workflow

1. Read `products.json`. Select the requested product(s), or every product with lifecycle `status: "new"` and `channels.dba.status` not `posted` when the user says "all new products". Never post a `sold` product.
2. Validate the product has a non-empty `title`, non-empty `description`, a non-negative numeric `price`, and at least one image path that exists on disk. Ask the user for anything missing instead of guessing.
3. Confirm `DBA_SELLER_POSTAL_CODE` is set in `.env` (see `.env.example`). If missing, ask the user for the postal code and write it to `.env` before continuing. Never put it in `products.json`.
4. Show the exact listing payload (title, description, price, postal code, image paths) for one product and ask the user to confirm before doing anything external.
5. On confirmation, run:
   ```
   node scripts/post_dba.js '<product-json>'
   ```
   passing `{ "title", "description", "price", "images" }` for that product as the JSON argument. This opens a real, visible browser window (needed for login cookies; API calls run through that authenticated session).
6. The script pauses via in-page overlay panels and never publishes without an explicit click. Every panel states what already happened and what happens next, so the user never has to guess what the agent is doing; between panels, a brief non-interactive status line ("Discovery: …", "Uploading N photo(s)…", "Saving draft…", "Publishing…") fills the gap instead of the panel going quiet.
   - First panel: the user logs in to DBA by hand in the browser (or resumes an existing session), then clicks "I'm logged in, continue" — the agent never sees or handles DBA credentials.
   - **Discovery phase**: the script creates a throwaway scratch draft, clicks "Markedspladsen" on DBA's start screen, and asks DBA for a category suggestion. If DBA suggests one, it's used automatically (shown, not asked for). If not, a panel tells the user to pick a category directly in DBA's own form; the script polls until a valid category is saved. Either way, a panel then collects height/width/depth (cm, pre-filled by guessing from the product's own text) and a condition dropdown (defaulted); the user confirms or corrects these and clicks Continue. The scratch draft is then deleted — nothing here is the real listing.
   - **Fill phase**: with every field decided, the script creates the real item, uploads images, and saves the draft via the API — no more field-collection panels — then shows a final review panel with the full draft (title, price, postal code, category, dimensions, condition, image count) plus any unresolved `violations` DBA reports, with "Publish listing" and "Cancel" buttons. Nothing is submitted until "Publish listing" is clicked.
7. Treat the run as successful only when the script prints `POSTED <listing_url>` on stdout. Any other output (`ERROR ...`, a crash, or the user closing the window early) is a failure — do not update `channels.dba.status`/`posted_at`/`listing_url` as posted in that case.
8. Regardless of success or failure, if the script printed a `FIELDS <json>` line (the discovered `{categoryId, categoryLabel, height, width, depth, condition}` from the discovery phase), store it verbatim as `channels.dba.fields` on that product and update `updated_at`. Discovery succeeding is reusable information even if the later publish step failed — persist it so a retry (or a future edit-and-repost) doesn't have to re-discover from scratch. Read `products.json` fresh right before this write in case other state changed concurrently.
9. On success (in addition to the `FIELDS` write above), also update `channels.dba.status` to `posted`, set `channels.dba.posted_at` to the current ISO-8601 UTC time, store `channels.dba.listing_url` from the script output, set the product lifecycle `status` to `posted` if it was `new`, and append a `posted` event with channel `dba` and the `price` the listing was posted at.
10. On failure, leave `channels.dba.status`/`posted_at`/`listing_url` as they were (only `fields`, if present, and `updated_at` change), append a `post_failed` event for channel `dba` with a safe summary of the error, and report the failure to the user without claiming a post happened.
11. Write the updated `products.json` after every run — success or failure — so the `fields` sync in step 8 always lands. When posting "all new products", repeat steps 4-10 for each product one at a time — never batch multiple listings into one confirmation.

## Setup this skill depends on

- `scripts/post_dba.js` launches Chromium headed via Playwright for login cookies, then drives DBA's recommerce JSON API directly (see "How this works" above) rather than filling form fields by selector. It collects category/dimensions/condition and gates the final publish call behind an in-page overlay the user must click through — never a terminal prompt.
- `DBA_SELLER_POSTAL_CODE` lives only in `.env` (gitignored), never in `products.json` or chat-derived files. `.env.example` documents the key.
- Never record or store login credentials or one-time passcodes anywhere in the repo, skill docs, or scripts. Login always happens by hand during the first pause. When capturing network traffic to debug this flow, scrub any captured login/OTP data before it's referenced anywhere persistent.
- If a run ever appears to hang with no terminal output changing, check the browser window first — the script is very likely waiting on one of the in-page overlay panels (login, category/dimensions, or publish confirmation), not stuck in the terminal.
