---
name: list-products
description: Lists products from products.json with lifecycle status, per-channel posting status, and timestamps, with filtering and interactive browsing. Use when the user wants to browse, list, view, search, or inspect products or check what's posted where.
---

# Skill: List products

Tools: Read on `products.json`.

## Workflow

1. Read `products.json`.
2. Return one compact row per product with title, price, image paths, lifecycle status (`new`, `posted`, or `sold`), and the relevant timestamps.
3. Include channel status and posted time for DBA and Facebook Marketplace when available.
4. Support filters for lifecycle status, channel, title, and ID.
5. When the user wants to browse interactively, present one product at a time with actions to edit, post, or mark sold. Route each action to its corresponding skill.

Never infer `posted` from a URL alone; use the recorded channel status. Never hide sold products unless the user filters them out.