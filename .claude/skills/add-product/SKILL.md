---
name: add-product
description: Adds a new product to products.json with title, description, price, and images, assigning it a stable ID and new lifecycle status. Use when the user wants to add, create, record, or stock a product.
---

# Skill: Add new product

Tools: Read and Write on `products.json`; AskUserQuestion for missing fields and draft confirmation.

## Workflow

1. Read `products.json`.
2. Ask for the product `title`, a `description`, and `price` if any are missing. The description can be given in either Danish or English — whichever the user finds natural. Ask for currency only when it is not clear; default to the products currency when one exists.
3. Derive the `id` from `title` now (see "ID convention" below) — it's needed to name the image folder in the next step.
4. Check whether `products/{id}/img/` already exists and has images in it (e.g. the user prepared a folder ahead of time). If it does, inspect it and include supported images. If it doesn't, create the empty folder and ask the user to add images to it, then wait for their confirmation before continuing — don't proceed with an empty `images` array without checking back, and don't guess filenames.
5. Read the `title` and `description` closely, and look at any images now available, and predict as much `metadata` (see below) as the text and photos support together — dimensions, condition, brand, model, materials, color, features, and included accessories. Extract everything stated or clearly shown; don't stop at the first field found. Never invent a value that isn't implied by the text or visible in a photo, and omit any field neither source supports rather than guessing a placeholder.
6. Propose an enriched rewrite of the description (see "Description enrichment" below), drawing on both the text and the images, as a separate, clearly-labeled suggestion — never silently substitute it for what the user gave you.
7. Show a concise draft — the original description, the enriched rewrite as an opt-in alternative, and any predicted `metadata` — and ask the user to confirm, including which description (original or enriched) to save. Call out predicted fields explicitly as predictions so the user can correct them before they're saved.
8. Once the description to save is settled (original or enriched, in whichever language the user wrote or picked), translate it into the other of Danish/English — every product is stored in both languages regardless of which one the user supplied — and show both `description_da` and `description_en` for a final check before writing, since a translation can shift nuance the user should be able to catch. Keep both versions faithful to the same facts; translating is not a second opportunity to enrich or add claims.
9. On confirmation, set `status` to `new`, set `created_at` and `updated_at` to the current ISO-8601 UTC time, initialize both channel records as `not_posted`, set `metadata` to whatever was predicted and confirmed (omit fields that weren't confidently predictable rather than storing null placeholders), and append a `product_added` event.
10. Write the updated `products.json`.
11. Report the new product ID, its `new` status, and any metadata that was predicted.

## Required fields

- `title`: non-empty string
- `description_da`: non-empty string (Danish)
- `description_en`: non-empty string (English)
- `price`: non-negative number

Both description fields are required on every product — see workflow step 8. `products.json` has no single `description` field.

## ID convention

`id` is `title` converted to snake_case:
- Lowercase; spaces and punctuation become single underscores; collapse repeated underscores; strip leading/trailing underscores.
- Transliterate non-ASCII letters rather than dropping them: æ→ae, ø→oe, å→aa (and equivalent accented-letter transliterations in other languages — spell out the sound, don't just strip the accent).
- Example: title "Kinnarps Stort Hæve-sænkebord med mavebue" → id `kinnarps_stort_haeve_saenkebord_med_mavebue`.

If the resulting id collides with an existing product's id, disambiguate by appending `_2`, `_3`, etc. — never silently overwrite another product. Pick the id before finalizing `images`, since the image folder path depends on it (see "Image paths" below).

## Image paths

Product images live under `products/{id}/img/` — e.g. product id `desk` → `products/desk/img/1.jpeg`, `products/desk/img/2.jpeg`. `images` in `products.json` is an array of these repo-relative paths, in the order they should be shown/uploaded.

- The `id` must be picked first (see "ID convention"), since the folder name depends on it.
- If `products/{id}/img/` doesn't exist yet, create it (`mkdir -p`) and tell the user where it is, then ask them to add image files there — wait for their reply rather than proceeding with an empty `images` array. If the user says they've added images, re-check the folder before writing `images`; don't take their word for filenames you haven't verified.
- If the folder already has images in it when you check (the user prepared it ahead of time, or is re-running this after adding files), skip the create-and-wait step and just use what's there.
- Before writing `images`, verify each path actually exists on disk (`find`/`ls` the folder) rather than assuming a filename — do not write a path for a file that isn't there.
- Include every supported image file found in the folder (commonly `.jpg`/`.jpeg`/`.png`/`.webp`), not just the first one — a listing folder can hold several photos.
- A product can be saved with an empty `images` array if the user explicitly declines to add any right now — don't block the whole add on images indefinitely; just don't silently skip asking.

## Metadata (predicted, channel-agnostic)

`metadata` is an optional object on the product holding every fact marketplaces commonly ask for beyond the core listing — it exists so posting skills (e.g. `post-dba`) can read stored values instead of re-deriving them from free text on every post attempt. Extract as much as the description *and* the product's images actually support, not just dimensions from text — read the description closely and look at the photos for brand, model/series, material, color, features, and included accessories. A visible detail is as valid a source as a stated one, as long as it's actually visible, not assumed. Shape:

```json
"metadata": {
  "dimensions_cm": { "height": 128, "width": 180, "depth": 90 },
  "condition": "used_good",
  "brand": "Kinnarps",
  "model": "Serie T",
  "materials": ["birch veneer", "matte metal"],
  "color": "birch",
  "features": ["electric height adjustment", "cable management", "cable tray", "pen holder"],
  "included_accessories": ["cable tray", "pen holder"]
}
```

- `dimensions_cm`: any subset of `height`/`width`/`depth`, each a positive number. Only include a key when the description states or clearly implies that measurement (e.g. "180 x 90 cm" → width/depth; "62-128 cm" adjustable range → height as the max). Omit `dimensions_cm` entirely if nothing in the text supports it.
- `condition`: one of `new`, `like_new`, `used_good`, `used_fair`, `worn` — set when the description's wording clearly implies a condition, or when photos clearly show visible wear, scuffs, or pristine/unused condition. Photo-based condition calls should be conservative: obvious, unambiguous wear only, not a guess from lighting or photo quality. Omit rather than defaulting to a guess. This is a channel-agnostic condition label, not any one marketplace's internal id — `post-dba` maps it to DBA's own `Stand` options itself.
- `brand`: the manufacturer/brand name, only when explicitly named in text or clearly legible on a logo/label in a photo.
- `model`: model or series name/number, only when explicitly named (e.g. "Serie (T)" → "Serie T").
- `materials`: array of materials explicitly named in text, or unambiguously identifiable in a photo (e.g. a visibly wood-grained tabletop) — flag photo-based material calls to the user as visual inferences, not certainties. Translate to the product's working language only for consistency, never rephrase into a stronger material claim than stated or shown.
- `color`: from an explicitly named color, a named material/finish that implies one (flag as inference), or directly observed in a photo — photos are actually the most reliable source for color, more so than most text descriptions.
- `features`: array of distinct functional features explicitly described in text or clearly visible in a photo (e.g. visible casters, a visible power outlet built into the item). Each entry should be a fact restated concisely, not embellished.
- `included_accessories`: array of physical items that come with the product, distinct from `features` — from text saying something is included, or from a photo that clearly shows a separate accessory alongside the main item (e.g. a remote, a charging cable) staged as part of the listing.

Every field follows the same rule: extract only what the text states or a photo unambiguously shows, never invent, and omit any field neither source supports rather than guessing a placeholder. This is a prediction from free text and images, not a source of truth — always show the full predicted `metadata` object to the user as a draft, note which fields came from a photo versus the text, and let them correct or clear any part of it before it's saved. Do not treat a missing or partial `metadata` field as a bug; not every product's description or photos support every field, and that's fine — a sparse but accurate `metadata` object is correct behavior, not a shortfall.

## Description enrichment

Goal: make the listing read as more compelling to a buyer scanning a marketplace — clearer structure, stronger opening line, concrete selling points surfaced — without adding a single claim that neither the original text nor the product's own photos actually support.

Hard rule: **only reorganize, rephrase, and emphasize what's already stated or clearly visible. Never add facts.** Concretely:
- Do not invent or upgrade condition claims ("like new", "barely used", "no scratches") unless the user's text says so or the photos unambiguously show it.
- Do not add measurements, materials, brand claims, feature counts, or compatibility claims that aren't in the original text and aren't clearly visible in a photo.
- Do not add urgency or scarcity language ("won't last", "priced to sell fast", "only one available") unless the user stated it.
- Do not add sensory or quality adjectives implying a condition/quality judgment beyond what's stated or shown (e.g. don't call something "pristine" or "flawless" from silence — silence is not evidence, and a single ordinary-looking photo isn't evidence of "flawless" either).
- Photos can supply genuinely new, truthful detail the text omitted — a visible color, a visible finish, a visible included accessory, a clearly visible feature (casters, a power outlet, a second shelf) — but only when it's unambiguous in the image. When you add a detail sourced from a photo rather than the user's own words, say so explicitly when presenting the draft, so the user can verify you read the photo correctly before it goes live.
- It's fine to reorder for impact (lead with the strongest true selling point), tighten wording, fix awkward phrasing, and make existing facts (dimensions, adjustability, materials, included accessories, visible color/finish) more scannable — that's presentation, not fabrication.

Always present the enriched version as a distinct, labeled alternative alongside the original — the user picks which one gets saved, and can also decline enrichment entirely and keep their own words verbatim. Enrichment happens once, on whichever language the user supplied text in; the subsequent Danish/English translation (workflow step 8) is a faithful rendering of that already-settled text into the other language, not a second enrichment pass — the same hard rule (no new facts) applies to translating for exactly the same reason.

## Memory shape

Follow the schema and product record shape established by `products.json`. Keep prices numeric; do not store currency symbols inside `price`.