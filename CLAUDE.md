# Blue Cross Agent

This agent is skill-based. Use the smallest matching skill for each request:

- `.claude/skills/add-product/SKILL.md`
- `.claude/skills/edit-product/SKILL.md`
- `.claude/skills/post-product/SKILL.md`
- `.claude/skills/post-dba/SKILL.md`
- `.claude/skills/post-facebook-marketplace/SKILL.md`
- `.claude/skills/mark-product-sold/SKILL.md`
- `.claude/skills/list-products/SKILL.md`

## Source of truth

`products.json` is the durable agent memory. Read it before changing products and write the complete updated JSON after a successful mutation. Do not use chat history as the products source of truth.

Each product has one lifecycle status: `new`, `posted`, or `sold`. Channel state is tracked independently under `channels.dba` and `channels.facebook_marketplace`, because an item can be posted to one marketplace while still being new on the other.

Every mutation appends an event with an ISO-8601 UTC timestamp. Preserve existing IDs, image paths, channel URLs, and event history unless the user explicitly asks to change them.

## Safety rules

- Ask for missing required values instead of guessing.
- Confirm before posting externally or marking an item sold.
- Never claim an external post succeeded without an adapter success response.
- Never delete inventory records to represent a sale; set lifecycle status to `sold` and retain the sale timestamp.
- When a user says "Facebook", interpret it as Facebook Marketplace for this agent.
