---
name: edit-product
description: Updates a product's title, description, or price in products.json and logs the change as an event. Use when the user wants to change, correct, update, or fix a product's listing details.
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