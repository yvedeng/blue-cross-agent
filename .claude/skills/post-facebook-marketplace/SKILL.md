---
name: post-facebook-marketplace
description: Posts a product listing to Facebook Marketplace via a headed Playwright browser, pausing for the user to log in (including 2FA) and to review/submit the filled form. Use when the user asks to post, list, or publish a product to Facebook or Facebook Marketplace specifically.
---

# Skill: Post product to Facebook Marketplace

"Facebook" always means Facebook Marketplace for this agent.

Tools: Read and Write on `products.json`; Bash to run `scripts/post_facebook_marketplace.js`; AskUserQuestion for missing fields and the pre-post confirmation.

## Workflow

1. Read `products.json`. Select the requested product(s), or every product with lifecycle `status: "new"` and `channels.facebook_marketplace.status` not `posted` when the user says "all new products". Never post a `sold` product.
2. Validate the product has a non-empty `title`, non-empty `description_da` and `description_en`, a non-negative numeric `price`, and at least one image path that exists on disk. Ask the user for anything missing instead of guessing.
3. Show the exact listing payload (title, both descriptions, price, image paths) for one product and ask the user to confirm before doing anything external.
4. On confirmation, run:
   ```
   node scripts/post_facebook_marketplace.js '<product-json>'
   ```
   passing `{ "title", "description_da", "description_en", "price", "images" }` for that product as the JSON argument. Facebook has one description textbox; the script combines the two itself (Danish, blank line, English) before filling it, same as `post-dba`. This opens a real, visible browser window.
5. The script pauses twice and needs the user at the keyboard both times:
   - First pause: the user logs in to Facebook by hand, including any 2FA or checkpoint, and reaches the Marketplace "create listing" form. The agent never sees or handles Facebook credentials.
   - Second pause: the script has filled what it could find (title, description, price, photos) and the user must set category/condition, check every field, fix anything wrong directly in the browser, and click submit themselves.
6. Treat the run as successful only when the script prints `POSTED <listing_url>` on stdout. Any other output (`ERROR ...`, a crash, or the user closing the window early) is a failure — do not update `products.json` as posted. Facebook blocks automated browsers more readily than DBA; a failure here is not unusual and should be reported plainly, not retried silently.
7. On success, update that product's `channels.facebook_marketplace.status` to `posted`, set `channels.facebook_marketplace.posted_at` to the current ISO-8601 UTC time, store `channels.facebook_marketplace.listing_url` from the script output, set the product lifecycle `status` to `posted` if it was `new`, set `updated_at`, and append a `posted` event with channel `facebook_marketplace` and the `price` the listing was posted at.
8. On failure, leave the Facebook channel state as-is, append a `post_failed` event for channel `facebook_marketplace` with a safe summary of the error, and report the failure to the user without claiming a post happened.
9. Write the updated `products.json`. When posting "all new products", repeat steps 3-8 for each product one at a time — never batch multiple listings into one confirmation.

## Setup this skill depends on

- `scripts/post_facebook_marketplace.js` launches Chromium headed via Playwright, fills fields it can locate by label (title, price, description), attaches images, then hands control back to the user for category/condition, review, and submit.
- If the script reports `WARNING could not find a <field> field automatically`, that field was left for the user to fill by hand during the second pause — call this out explicitly when asking the user to review.
