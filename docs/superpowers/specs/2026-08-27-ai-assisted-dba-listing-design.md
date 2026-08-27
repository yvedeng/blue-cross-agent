# AI-assisted DBA listing: design

Date: 2026-08-27

## Problem

Adding a product currently requires the user to type a finished `title`/`description` by hand, and posting to DBA fills condition with a hardcoded default and only handles one kind of DBA-reported "missing field" (`category`) — any other required field DBA might ask for is invisible until it shows up as raw text in the final review panel, with no way to fill it.

## Goals

1. Let the user add a product from rough notes + photos; AI drafts the listing copy for approval instead of the user writing it from scratch.
2. Let AI propose a condition (Stand) value from photos + description, instead of a hardcoded default — still user-editable.
3. Make `post-dba` resilient to DBA requiring a field the script doesn't already know about, without hardcoding DBA's schema in advance.

## Non-goals

- No live DOM/accessibility-tree-driven form filling (e.g. Playwright MCP). Considered and rejected — see "Rejected approach" below.
- No new `products.json` schema fields. Both predictions (copy, condition) resolve to plain existing fields (`title`, `description`) or existing script inputs (`condition`), gated by the same user-confirmation points that already exist.
- No change to the category-prediction flow, which already works via DBA's own AI (`predictions/categories/{id}`).

## Rejected approach: live DOM-driven agent (Playwright MCP)

Considered switching `post-dba` to an MCP-driven agent that reads DBA's rendered page turn-by-turn (`browser_snapshot`, `browser_click`, `browser_type`) and decides each field's value live, instead of calling DBA's JSON API directly.

Rejected because:
- `post_dba.js`'s existing design deliberately moved *away* from DOM/selector-driven interaction toward DBA's stable JSON API, for reasons captured at length in `post-dba/SKILL.md`'s "How this works" section — most concretely, the image-upload investigation, where even a byte-identical direct API request failed and only driving the real file input worked, for reasons never fully explained. That history is evidence the DOM/API boundary in this app is not uniformly reliable in either direction, and the current script already encodes the working answer per-step.
- The actual motivating problem — DBA requiring a field the script doesn't know about — doesn't need page-reading at all. DBA's own draft-save response (`PUT .../item/{id}`) already returns a structured `violations` array naming exactly which fields are unmet, which is more reliable than inferring missing fields from a rendered page.
- Rebuilding the validate/category-predict/draft-save/publish sequence as click/type actions would mean re-deriving a large amount of already-working, already-tested behavior for no gain on the one gap that actually exists.

## Design

### Part 1 — `add-product`: AI-drafted copy

Today `add-product` requires the user to supply finished `title`/`description`/`price`. New: the user may instead give rough notes (e.g. "old Kinnarps desk, some scratches") plus image paths/folder. Claude reads the images and notes and drafts a `title`/`description` in the style of existing listings (Danish; matches tone/format of current entries in `products.json`), and proposes a `price` only when the user hasn't given one. The draft is shown at the skill's existing confirmation step (today's step 4) before being written — same gate, AI-generated content instead of user-typed content, fully editable before confirming.

No schema change: the confirmed draft is written as ordinary `title`/`description` strings, indistinguishable from hand-written copy once saved.

### Part 2 — `post-dba`: predicted condition

`collectAttributes()` (`post_dba.js:364-446`) currently defaults the Stand dropdown to a hardcoded `DEFAULT_CONDITION_ID` (3, "God, brugt stand"). New: before rendering that panel, the calling skill inspects the product's images + description (same combined signal as Part 1) and computes a proposed condition id from `CONDITION_OPTIONS`. This becomes the panel's pre-selected value instead of the hardcoded default.

Mechanism: `post_dba.js` needs to accept a condition default as an input (e.g. an optional `condition` field on the product-JSON CLI argument) rather than hardcoding `DEFAULT_CONDITION_ID` — the prediction happens in the skill's own reasoning (Claude reading images via the Read tool, same as Part 1), and is passed into the script, not computed inside the script. If absent, fall back to the current hardcoded default. The panel remains fully editable; nothing about the user confirmation gate changes.

Dimensions keep their existing regex-guess (`guessDimensionsFromText`) — out of scope for this change.

### Part 3 — `post-dba`: unknown required fields

Today, `saveDraft()`'s `violations` response is only handled for `field === "category"` (via `waitForManualCategoryPick`). Any other violation is inert — it flows through to the final review panel as raw text with no way to act on it.

New two-layer handling, added after category is resolved and before/alongside the draft save:

1. **Attempt DBA's attribute prediction.** Call `POST /recommerce/create/api/predictions/attributes/{itemId}` (documented as unused in the current SKILL.md's "Known gaps") and apply any suggested values it returns for fields DBA later reports as violations. This endpoint's response shape is **unverified** — inferred only from its naming symmetry with the already-working `predictions/categories/{id}` call, not from captured traffic. It must be exercised against a real DBA session before being trusted; if it does not behave as expected (wrong shape, error, no suggestion for a violated field), fall through to step 2 for that field.
2. **Generic pause-and-ask fallback**, for any violation neither category-handling nor the attribute prediction resolves: render a new overlay panel showing the violated field's name and DBA's own violation message, with a text input. This reuses the script's existing pause mechanism verbatim — `page.exposeFunction` + a Node-side polling loop, the same pattern already proven by `waitForLogin` and `waitForManualCategoryPick`. Submitted values feed back into the draft data, the draft is re-saved, and the loop repeats until no unhandled violations remain or the user cancels.

Because step 2 only depends on already-confirmed API behavior (the `violations` array, draft-save/re-save), it should be implemented and working first. Step 1 is a strict improvement layered on top — it never removes the ability to fall back to asking the user, it only reduces how often that's needed.

## Testing

- Part 1: exercise `add-product` with rough notes + a real product photo, confirm the drafted copy reads sensibly and the confirmation gate still blocks writing until approved.
- Part 2: exercise `post-dba` on a product with clearly visible wear in its photos, confirm the panel's condition dropdown pre-selects something other than the hardcoded default and remains editable.
- Part 3: exercise against a real DBA session; if a violation for a field other than `category` appears, confirm the generic panel renders with DBA's own message and that a submitted value clears the violation on re-validate. Since this can't be forced deterministically (depends on what DBA currently requires), also verify by code review that the fallback path is reachable and blocks correctly even if never triggered in a live test session.
