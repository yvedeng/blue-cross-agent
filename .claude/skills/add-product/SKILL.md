---
name: add-product
description: Adds a new product to products.json with title, description, price, and images, assigning it a stable ID and new lifecycle status. Use when the user wants to add, create, record, or stock a product.
---

# Skill: Add new product

Tools: Read and Write on `products.json`; AskUserQuestion for missing fields and draft confirmation.

## Workflow

1. Read `products.json`.
2. Ask for the product `title`, `description`, and `price` if any are missing. Ask for currency only when it is not clear; default to the products currency when one exists.
3. Optionally ask for image paths. If the user is adding an item from an existing product folder, inspect that folder and include supported images.
4. Show a concise draft and ask the user to confirm.
5. On confirmation, create a unique stable ID, set `status` to `new`, set `created_at` and `updated_at` to the current ISO-8601 UTC time, initialize both channel records as `not_posted`, and append a `product_added` event.
6. Write the updated `products.json`.
7. Report the new product ID and its `new` status.

## Required fields

- `title`: non-empty string
- `description`: non-empty string
- `price`: non-negative number

## Memory shape

Follow the schema and product record shape established by `products.json`. Keep prices numeric; do not store currency symbols inside `price`.