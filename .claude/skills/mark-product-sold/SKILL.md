---
name: mark-product-sold
description: Marks a product sold in products.json, recording the sale timestamp while preserving listing and channel history. Use when the user says a product sold, asks to mark it sold, or completes a sale.
---

# Skill: Mark product sold

Tools: Read and Write on `products.json`; AskUserQuestion for confirmation before changing state.

## Workflow

1. Read `products.json` and identify the product by ID or title.
2. Show the matching product and ask for confirmation before changing state.
3. On confirmation, set lifecycle `status` to `sold`, set `sold_at` and `updated_at` to ISO-8601 UTC timestamps, and append a `sold` event. Preserve all listing records and URLs.
4. Write `products.json` and report the sale timestamp.

If the user gives a sale time, preserve it as `sold_at` when it is a valid ISO-8601 timestamp; otherwise use the current time. Do not delete the product record.