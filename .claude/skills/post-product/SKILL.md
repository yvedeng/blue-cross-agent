---
name: post-product
description: Routes a product-posting request to the right marketplace skill(s), asking which channels to use when none is named. Use when the user asks to post, list, or publish a product without naming one specific marketplace, or asks to post to "all marketplaces" or "everywhere".
---

# Skill: Post product to marketplace(s)

Tools: Read on `products.json`; AskUserQuestion to choose channels; Skill to invoke each channel's own skill (this skill never writes `products.json` or runs Bash itself).

## Supported channels

- `dba` → `.claude/skills/post-dba/SKILL.md`
- `facebook_marketplace` → `.claude/skills/post-facebook-marketplace/SKILL.md`

Adding a new marketplace later means adding one row here and one new `post-<channel>` skill; nothing else in this workflow changes.

## Workflow

1. Read `products.json` and identify the requested product(s) by ID, title, or "all new products".
2. Determine which channels to post to:
   - If the user named one or more channels, use those.
   - If the user said "all", "everywhere", or gave no channel, ask which of the supported channels above to use — do not guess, since posting is an external, hard-to-reverse action.
3. For each selected product, show its current channel state (from `channels.<name>.status`) so the user can see what's already posted where before deciding again. Skip a channel for a product that already shows `posted` there unless the user explicitly asks to repost.
4. For each remaining (product, channel) pair, invoke that channel's own skill (see table above) and let it run its full workflow, including its own confirmation, browser automation, and `products.json` update. This skill does not duplicate that mechanics — each channel skill is the source of truth for how its posting works.
5. Process channels for a product one at a time, not concurrently, since each opens its own interactive browser window.
6. After all pairs are processed, summarize per product: which channels succeeded (with `listing_url`), which failed, and which were skipped as already-posted.

## Memory

`products.json` already carries the full cross-channel memory this skill relies on: each product's `channels.<name>.status`, `posted_at`, and `listing_url`, plus an event history where each `posted` event records the channel and the price it was posted at. This skill reads that state to decide what to skip and reports from it, but never writes to `products.json` directly — only the invoked channel skill does, after its own successful post.
