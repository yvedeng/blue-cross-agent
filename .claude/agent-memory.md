# Product agent memory

The durable product memory is stored in `products.json`.

The agent must preserve:

- stable product IDs
- title, description, numeric price, and image paths
- lifecycle status and timestamps
- independent DBA and Facebook Marketplace posting status
- external listing IDs and URLs returned by adapters
- append-only event history for inventory changes, posts, failures, and sales

When the schema evolves, update the inventory records and the skill instructions together. Never store login credentials, access tokens, or browser session data in this repository.
