---
name: edit-product
description: Updates a product's title, description, price, or metadata in products.json and logs the change as an event. Use when the user wants to change, correct, update, or fix a product's listing details.
---

# Skill: Edit product

Tools: Read and Write on `products.json`; AskUserQuestion when more than one product matches.

## Workflow

1. Read `products.json` and identify the product by ID, exact title, or a clarification question when ambiguous.
2. Show the current values and the proposed changes.
3. Ask for confirmation when more than one product matches; otherwise apply the clearly requested edit directly.
4. Update only requested fields, set `updated_at`, and append an event with the changed field names and old/new values.
5. Write `products.json` and report the result.

Price must remain a non-negative number. Changing a sold product is allowed for correcting its listing data, but does not restore its status or repost it.

## Metadata edits

`metadata` (see `add-product`'s Metadata section for its full shape — dimensions, condition, brand, model, materials, color, features, included accessories) can be added, corrected, or cleared like any other field: merge in only the keys the user specifies, don't silently touch the rest of `metadata`, and don't invent a value the user didn't provide or that isn't stated in the product's own `title`/`description`. If `metadata` doesn't exist yet on a product, add it fresh rather than requiring the user to go through `add-product` again.

## id and images

Images live at `products/{id}/img/...` (see `add-product`'s "Image paths" section) — the `id` is part of the path, not just a label. If the user asks to change a product's `id`, the `products/{id}/img/` folder does not rename itself:
- Check whether a folder already exists at the new `products/{new-id}/img/` path with the same images already there (a rename may have already happened on disk, as when a user renames the folder outside this tool) — if so, just update `images` to match, no file move needed.
- Otherwise, `images` still points at the old path and would break; ask the user whether to move the folder on disk or leave `images` pointing at the old path (valid but no longer matching the `products/{id}/img/` convention).
Either way, verify the paths actually exist on disk before writing them into `images` — don't assume a path resolves just because it matches the naming pattern.