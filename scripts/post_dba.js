// Posts one listing to DBA.dk by driving DBA's own recommerce create-item
// JSON API from an authenticated Playwright browser session.
//
// Usage: node scripts/post_dba.js '{"title":"...","description":"...","price":999,"images":["products/x/img/a.jpg"]}'
//
// Reverse-engineered from a real posting flow captured with Playwright's
// network recorder (2026-08-27). The DBA "create listing" UI is a thin
// client over a stable JSON API:
//   - GET  /recommerce/create/api/user/postalcode        account default postal code
//   - PUT  /recommerce/create/api/item/{id}/validate      creates the draft, returns missing fields
//   - PUT  /recommerce/create/api/item/{id}               {commit:false, data:{address}} must happen
//     at least once BEFORE the first image upload — uploading straight after
//     validate returns HTTP 500.
//   - POST /recommerce/create/api/image/{id}?type=&size=  raw image bytes as body -> {uri,height,width}
//   - POST /recommerce/create/api/predictions/categories/{id}   AI category suggestion from title/image
//   - PUT  /recommerce/create/api/item/{id}               {commit, data:{...accumulated fields}}
//     commit:false saves a draft and returns remaining `violations`;
//     commit:true is the actual publish call.
//   - POST /recommerce/delivery/api/delivery?finnkode={id}      {meetup, shipping}
//   - POST /recommerce/choose-products/api/ordernow?adId={id}&productSpecificationUrns=...  listing tier
//   - GET  /my-items/details/{id}/api/single?adId={id}    status polling (DRAFT -> PENDING -> ...)
//
// The item id itself is minted by DBA when the browser navigates to
// /create-item/start (it redirects to /recommerce/create/{id}), not by an
// API call, so this script still drives that one navigation.
//
// All user interaction happens through a floating control panel injected
// into the DBA page itself (not the terminal) — running this script through
// a host that doesn't reliably pipe keystrokes to a background process's
// stdin (e.g. an agent's sandboxed shell) can otherwise leave a
// readline-based prompt stuck forever with no visible symptom. The overlay
// sidesteps that: every input is a click or a form field in the browser
// window the user is already looking at.
//
// Runs in two phases:
//   Phase 1 — Discover (discoverFields): creates a throwaway scratch item
//     to see what DBA actually wants for this product — its own AI category
//     suggestion, and the category/dimensions/condition fields it requires.
//     Every field is decided here: DBA's category suggestion is used
//     automatically when available (or the user picks one by hand in DBA's
//     real form if not); height/width/depth are guessed by parsing the
//     product's own title/description text, condition defaults to "used,
//     good condition" — both shown as editable inputs, not silently
//     assumed. The scratch item is deleted once discovery is done.
//   Phase 2 — Fill (fillAndPublish): with every field already decided,
//     creates the real item and fills it in one pass via the API — no more
//     field-collection prompts, only a final review panel with
//     Publish/Cancel before the actual commit:true publish call.
//
// The user is only interrupted at: login, and (during discovery only) the
// item-details panel or a manual category pick if DBA had no suggestion.
// Nothing publishes without an explicit click on the final review panel.
//
// On success prints exactly: POSTED <listing_url>
// On any failure prints:      ERROR <message>

require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const CONDITION_OPTIONS = [
  { id: 1, label: "Ny" },
  { id: 2, label: "Som ny" },
  { id: 3, label: "God, brugt stand" },
  { id: 4, label: "Brugt, men fungerer fint" },
  { id: 5, label: "Slidt" },
];

const DEFAULT_CONDITION_ID = 3; // "God, brugt stand" — the common case for a used marketplace listing

// Best-effort dimension extraction from free-text product copy (title +
// description), so the item-details panel can arrive pre-filled instead of
// blank when the product's own listing text already states its size —
// e.g. "180 x 90 cm" (footprint) or "62-128 cm" (an adjustable range, taken
// as the max). This is a guess, not a source of truth: the panel always
// shows these as editable inputs so the user can correct a wrong parse
// before continuing.
function guessDimensionsFromText(text) {
  const dims = { height: null, width: null, depth: null };
  if (!text) return dims;

  // "180 x 90 cm" / "180x90x70cm" — an L x W (x D) footprint
  const footprint = text.match(/(\d{2,4})\s*[x×]\s*(\d{2,4})(?:\s*[x×]\s*(\d{2,4}))?\s*cm/i);
  if (footprint) {
    dims.width = Number.parseInt(footprint[1], 10);
    dims.depth = Number.parseInt(footprint[2], 10);
    if (footprint[3]) dims.height = Number.parseInt(footprint[3], 10);
  }

  // "62-128 cm" / "62 til 128 cm" — an adjustable range; use the max as height
  const range = text.match(/(\d{2,4})\s*(?:-|til)\s*(\d{2,4})\s*cm/i);
  if (range && dims.height === null) {
    dims.height = Math.max(Number.parseInt(range[1], 10), Number.parseInt(range[2], 10));
  }

  return dims;
}

const OVERLAY_CSS = `
  #dba-agent-overlay { position: fixed; top: 16px; right: 16px; z-index: 2147483647;
    width: 360px; background: #fff; color: #111; border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.35); font-family: -apple-system, sans-serif;
    font-size: 13px; padding: 16px; max-height: 90vh; overflow-y: auto; }
  #dba-agent-overlay .drag-handle { cursor: move; margin: -16px -16px 10px; padding: 10px 16px;
    background: #f5f5f5; border-radius: 12px 12px 0 0; display: flex; justify-content: space-between;
    align-items: center; user-select: none; }
  #dba-agent-overlay .drag-handle h2 { margin: 0; font-size: 14px; }
  #dba-agent-overlay .minimize-btn { border: none; background: none; cursor: pointer;
    font-size: 16px; line-height: 1; padding: 0 4px; color: #666; width: auto; margin: 0; }
  #dba-agent-overlay.minimized .panel-body { display: none; }
  #dba-agent-overlay label { display: block; margin: 8px 0 2px; font-weight: 600; }
  #dba-agent-overlay input, #dba-agent-overlay select { width: 100%; box-sizing: border-box;
    padding: 6px 8px; border: 1px solid #ccc; border-radius: 6px; font-size: 13px; }
  #dba-agent-overlay .row { display: flex; gap: 8px; }
  #dba-agent-overlay .row > div { flex: 1; }
  #dba-agent-overlay button.primary, #dba-agent-overlay button.secondary { margin-top: 12px;
    padding: 8px 14px; border-radius: 6px; border: none; font-size: 13px; font-weight: 600;
    cursor: pointer; width: 100%; }
  #dba-agent-overlay .primary { background: #0a6cff; color: #fff; }
  #dba-agent-overlay .secondary { background: #eee; color: #111; margin-top: 6px; }
  #dba-agent-overlay .hint { color: #666; font-size: 12px; margin-top: 4px; }
  #dba-agent-overlay .warn { color: #b3261e; font-size: 12px; margin-top: 8px; }
`;

// Wraps panel HTML with a draggable title bar (the whole overlay can be
// dragged anywhere by that bar) and a minimize toggle, so the panel never
// permanently blocks whatever it happens to be sitting on top of.
function withDragAndMinimize(title, bodyHtml) {
  return `
    <div class="drag-handle" id="dba-agent-drag-handle">
      <h2>${title}</h2>
      <button class="minimize-btn" id="dba-agent-minimize" type="button">&#8211;</button>
    </div>
    <div class="panel-body">${bodyHtml}</div>
  `;
}

// Runs inside the page. Exposes window.__dbaAgentWithDragAndMinimize (wraps
// panel HTML with a draggable title bar + minimize toggle) and
// window.__dbaAgentAttachDragAndMinimize (wires up the drag/minimize
// behavior on an appended element), so every panel builder can reuse both
// without re-declaring this logic inline in each page.evaluate block.
function attachDragAndMinimizeSource() {
  window.__dbaAgentWithDragAndMinimize = (title, bodyHtml) => `
    <div class="drag-handle" id="dba-agent-drag-handle">
      <h2>${title}</h2>
      <button class="minimize-btn" id="dba-agent-minimize" type="button">&#8211;</button>
    </div>
    <div class="panel-body">${bodyHtml}</div>
  `;

  window.__dbaAgentAttachDragAndMinimize = (el) => {
    const handle = el.querySelector("#dba-agent-drag-handle");
    const minimizeBtn = el.querySelector("#dba-agent-minimize");

    minimizeBtn.addEventListener("click", () => {
      el.classList.toggle("minimized");
      minimizeBtn.innerHTML = el.classList.contains("minimized") ? "&#43;" : "&#8211;";
    });

    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener("mousedown", (e) => {
      if (e.target === minimizeBtn) return;
      dragging = true;
      const rect = el.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      el.style.right = "auto";
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      el.style.left = `${e.clientX - offsetX}px`;
      el.style.top = `${e.clientY - offsetY}px`;
    });

    document.addEventListener("mouseup", () => {
      dragging = false;
    });
  };
}

async function injectOverlay(page) {
  await page.addStyleTag({ content: OVERLAY_CSS });
  await page.evaluate(attachDragAndMinimizeSource);
}

// Brief, non-interactive status line shown between panels (e.g. while
// uploading images or saving the draft) so the overlay never goes quiet
// with no indication of what the agent is doing.
async function showStatus(page, message) {
  await injectOverlay(page);
  try {
    await page.evaluate((message) => {
      let el = document.getElementById("dba-agent-overlay");
      if (!el) {
        el = document.createElement("div");
        el.id = "dba-agent-overlay";
        document.body.appendChild(el);
        window.__dbaAgentAttachDragAndMinimize(el);
      }
      el.innerHTML = window.__dbaAgentWithDragAndMinimize(
        "Blue Cross Agent",
        `<div class="hint">${message}</div>`
      );
      window.__dbaAgentAttachDragAndMinimize(el);
    }, message);
  } catch {
    // page mid-navigation; not worth retrying for a transient status line
  }
}

const LOGIN_OVERLAY_MARKUP = withDragAndMinimize(
  "Blue Cross Agent",
  `
    <div class="hint">Step 1 of 2 — Log in</div>
    <div class="hint">Log in to DBA in this window (or resume an existing session), then click below. Next, the agent will figure out what DBA needs for this item (category, dimensions, condition) using a throwaway scratch draft, before creating and filling in the real listing.</div>
    <button class="primary" id="dba-agent-login-done">I'm logged in, continue</button>
  `
);

// Login can involve DBA navigating the page (redirects through id.dba.dk and
// back), which destroys any pending page.evaluate()'s JS execution context
// and would silently kill an in-page Promise. So this waits by polling a
// Node-side flag set via an exposed function, and re-injects the overlay on
// every navigation rather than relying on a single long-lived evaluate call.
async function waitForLogin(page) {
  let loggedIn = false;
  await page.exposeFunction("dbaAgentLoginDone", () => {
    loggedIn = true;
  });

  const inject = async () => {
    try {
      await injectOverlay(page);
      await page.evaluate((markup) => {
        if (document.getElementById("dba-agent-overlay")) return;
        const el = document.createElement("div");
        el.id = "dba-agent-overlay";
        el.innerHTML = markup;
        document.body.appendChild(el);
        window.__dbaAgentAttachDragAndMinimize(el);
        document.getElementById("dba-agent-login-done").addEventListener("click", () => {
          el.remove();
          window.dbaAgentLoginDone();
        });
      }, LOGIN_OVERLAY_MARKUP);
    } catch {
      // page mid-navigation; the 'load' listener below will retry
    }
  };

  page.on("load", () => {
    inject();
  });
  await inject();

  while (!loggedIn) {
    await page.waitForTimeout(500);
  }
  page.removeAllListeners("load");
}

// DBA does not expose an API to list category-tree options — the
// Hovedkategori/Underkategori/Produktkategori dropdowns are driven by a
// tree baked into DBA's own frontend bundle, not fetched over the network.
// Replicating that tree in this script's overlay would mean reverse
// engineering and maintaining a copy of DBA's entire category taxonomy,
// which would silently go stale. So this always defers to DBA's own AI
// category-prediction endpoint (POST .../predictions/categories/{itemId})
// — the same classifier a human would otherwise be approximating by eye —
// and only asks the user to pick a category by hand, in DBA's real form,
// when that classifier returns nothing.
async function resolveCategory(page, request, itemId, title) {
  const predictionRes = await request.post(
    `https://www.dba.dk/recommerce/create/api/predictions/categories/${itemId}`
  );
  let suggestion = null;
  if (predictionRes.ok()) {
    const body = await predictionRes.json();
    suggestion = body?.prediction?.categories?.[0];
  }
  if (suggestion) {
    const suggestionPath = [suggestion.label, suggestion.parent?.label, suggestion.parent?.parent?.label]
      .filter(Boolean)
      .join(" < ");
    return { categoryId: suggestion.id, categoryLabel: suggestionPath };
  }

  console.log(`No DBA category suggestion for "${title}" — pick one manually in the browser form.`);
  return waitForManualCategoryPick(page, request, itemId);
}

// Fallback path when DBA's classifier has no suggestion: DBA's create-item
// page already renders the real Hovedkategori/Underkategori/Produktkategori
// dropdowns (the overlay just sits on top of them), so the user picks a
// category there directly. This polls item state via the validate endpoint
// until the MANDATORY "category" violation clears, meaning a valid leaf
// category id has been saved, then reads it back.
async function waitForManualCategoryPick(page, request, itemId) {
  await injectOverlay(page);
  await page.evaluate(() => {
    if (document.getElementById("dba-agent-overlay")) return;
    const el = document.createElement("div");
    el.id = "dba-agent-overlay";
    el.innerHTML = window.__dbaAgentWithDragAndMinimize(
      "Pick a category",
      `
        <div class="hint">Step 2 of 2 — Discovery: category (manual)</div>
        <div class="hint">DBA's AI classifier had no automatic suggestion for this item. Use the Hovedkategori/Underkategori/Produktkategori dropdowns on this page directly (drag this panel out of the way if needed). This is a throwaway scratch draft, not the real listing — it will be deleted once discovery is done.</div>
        <div class="hint">This panel is just watching — it will detect your selection and continue automatically once a valid category is saved. No need to click anything here.</div>
      `
    );
    document.body.appendChild(el);
    window.__dbaAgentAttachDragAndMinimize(el);
  });

  for (;;) {
    const res = await request.put(`https://www.dba.dk/recommerce/create/api/item/${itemId}/validate`, {
      data: { trade_type: "SELL" },
    });
    if (res.ok()) {
      const body = await res.json();
      const categoryId = body?.data?.category;
      const stillInvalid = (body.violations || []).some((v) => v.field === "category");
      if (categoryId && !stillInvalid) {
        await page.evaluate(() => document.getElementById("dba-agent-overlay")?.remove());
        return { categoryId, categoryLabel: `id ${categoryId} (picked manually)` };
      }
    }
    await page.waitForTimeout(1000);
  }
}

async function collectAttributes(page, title, description, categoryLabel) {
  const guessed = guessDimensionsFromText(`${title} ${description}`);
  const hasAnyGuess = guessed.height !== null || guessed.width !== null || guessed.depth !== null;

  let submitted = null;
  await page.exposeFunction("dbaAgentAttributesSubmit", (values) => {
    submitted = values;
  });

  await injectOverlay(page);
  await page.evaluate(
    ({ title, categoryLabel, conditionOptions, guessed, hasAnyGuess, defaultConditionId }) => {
      const el = document.createElement("div");
      el.id = "dba-agent-overlay";
      el.innerHTML = window.__dbaAgentWithDragAndMinimize(
        "Item details",
        `
          <div class="hint">Step 2 of 2 — Discovery: item details</div>
          <div class="hint">Listing: "${title}"</div>
          <div class="hint">Category: ${categoryLabel}</div>
          <div class="hint">${
            hasAnyGuess
              ? "Pre-filled by guessing from the product's own title/description — check these before continuing, DBA needs them but they aren't tracked in products.json."
              : "Couldn't guess these from the product text — please fill them in."
          } This is a throwaway scratch draft used only to figure out what DBA needs. After Continue, the agent deletes it and creates the real listing with these values.</div>
          <div class="row">
            <div><label>Højde (cm)</label><input id="dba-agent-height" type="number" value="${guessed.height ?? ""}" /></div>
            <div><label>Bredde (cm)</label><input id="dba-agent-width" type="number" value="${guessed.width ?? ""}" /></div>
            <div><label>Dybde (cm)</label><input id="dba-agent-depth" type="number" value="${guessed.depth ?? ""}" /></div>
          </div>
          <label>Stand (condition)</label>
          <select id="dba-agent-condition">
            ${conditionOptions
              .map(
                (o) =>
                  `<option value="${o.id}" ${o.id === defaultConditionId ? "selected" : ""}>${o.label}</option>`
              )
              .join("")}
          </select>
          <button class="primary" id="dba-agent-continue">Continue</button>
          <div class="warn" id="dba-agent-error" style="display:none"></div>
        `
      );
      document.body.appendChild(el);
      window.__dbaAgentAttachDragAndMinimize(el);

      document.getElementById("dba-agent-continue").addEventListener("click", () => {
        const height = Number.parseInt(document.getElementById("dba-agent-height").value, 10);
        const width = Number.parseInt(document.getElementById("dba-agent-width").value, 10);
        const depth = Number.parseInt(document.getElementById("dba-agent-depth").value, 10);
        const condition = Number.parseInt(document.getElementById("dba-agent-condition").value, 10);

        const errorEl = document.getElementById("dba-agent-error");
        if (![height, width, depth, condition].every(Number.isFinite)) {
          errorEl.textContent = "Please fill in every field with a number.";
          errorEl.style.display = "block";
          return;
        }

        el.remove();
        window.dbaAgentAttributesSubmit({ height, width, depth, condition });
      });
    },
    {
      title,
      categoryLabel,
      conditionOptions: CONDITION_OPTIONS,
      guessed,
      hasAnyGuess,
      defaultConditionId: DEFAULT_CONDITION_ID,
    }
  );

  while (submitted === null) {
    await page.waitForTimeout(500);
  }
  return submitted;
}

async function uploadImages(request, itemId, images) {
  const uploaded = [];
  for (const imagePath of images) {
    const absolutePath = path.resolve(imagePath);
    const bytes = fs.readFileSync(absolutePath);
    const ext = path.extname(absolutePath).toLowerCase();
    const mime = ext === ".png" ? "image/png" : "image/jpeg";

    const res = await request.post(
      `https://www.dba.dk/recommerce/create/api/image/${itemId}?type=${encodeURIComponent(mime)}&size=${bytes.length}`,
      { data: bytes, headers: { "content-type": mime } }
    );
    if (!res.ok()) {
      throw new Error(`image upload failed for ${imagePath}: HTTP ${res.status()}`);
    }
    const body = await res.json();
    uploaded.push({ uri: body.data.uri, width: body.data.width, height: body.data.height, description: "" });
  }
  return uploaded;
}

async function saveDraft(request, itemId, data) {
  const res = await request.put(`https://www.dba.dk/recommerce/create/api/item/${itemId}`, {
    data: { commit: false, data },
  });
  if (!res.ok()) {
    throw new Error(`draft save failed: HTTP ${res.status()}`);
  }
  return res.json();
}

async function startNewDraft(page, request, postalCode) {
  await page.goto("https://www.dba.dk/create-item/start");

  // /create-item/start shows a two-way choice (Markedspladsen vs Motor)
  // before it will mint a new item id. This script only ever posts regular
  // marketplace items, so it always picks Markedspladsen; if that option
  // isn't there (DBA changed the screen, or it's showing something else
  // entirely), fall through and let the waitForURL below time out with a
  // diagnostic rather than clicking the wrong thing blindly.
  try {
    await page.getByText("Markedspladsen", { exact: false }).first().click({ timeout: 10000 });
  } catch {
    // no such option on this screen — maybe DBA already skipped straight
    // to the item form, or the screen looks different than expected
  }

  try {
    await page.waitForURL(/\/recommerce\/create\/\d+/, { timeout: 60000 });
  } catch {
    throw new Error(
      `DBA did not redirect to a new item id within 60s (stuck on ${page.url()}) — it may be showing an intermediate screen (e.g. Markedspladsen/Motor choice) that this script couldn't click through; check the browser and re-run`
    );
  }
  const match = /\/recommerce\/create\/(\d+)/.exec(page.url());
  if (!match) {
    throw new Error(`could not determine new item id from DBA redirect (landed on ${page.url()})`);
  }
  const itemId = match[1];

  await request.put(`https://www.dba.dk/recommerce/create/api/item/${itemId}/validate`, {
    data: { trade_type: "SELL" },
  });

  // DBA's own flow saves an initial draft (address only) before it will
  // accept an image upload for the item — skipping straight from validate
  // to an image POST returns HTTP 500. Mirror that sequencing here. Only
  // needed when this item will actually have images uploaded to it (the
  // discovery-phase scratch item never does, so postalCode is null there
  // and this step is skipped).
  if (postalCode) {
    await request.put(`https://www.dba.dk/recommerce/create/api/item/${itemId}`, {
      data: { commit: false, data: { trade_type: "SELL", address: { postalcode: postalCode, country: "DK" } } },
    });
  }

  return itemId;
}

async function reviewDraftWithUser(page, itemId, draftResult, fields) {
  const { title, price, postalCode, categoryId, categoryLabel, height, width, depth, condition, uploadedImages } =
    fields;
  const remainingViolations = draftResult.violations || [];

  let decision = null;
  await page.exposeFunction("dbaAgentPublishDecision", (value) => {
    decision = value;
  });

  await injectOverlay(page);
  await page.evaluate(
    (
      { itemId, title, price, postalCode, categoryId, categoryLabel, height, width, depth, condition, imageCount, violations }
    ) => {
      const el = document.createElement("div");
      el.id = "dba-agent-overlay";
      el.innerHTML = window.__dbaAgentWithDragAndMinimize(
        "Ready to publish",
        `
          <div class="hint">Filling done — final review before publishing</div>
          <div class="hint">This is the real listing draft (discovery's scratch draft was already deleted). The agent has filled everything below. Nothing has been published yet. Draft: https://www.dba.dk/recommerce/create/${itemId}</div>
          <div><b>Title:</b> ${title}</div>
          <div><b>Price:</b> ${price} DKK</div>
          <div><b>Postal code:</b> ${postalCode}</div>
          <div><b>Category:</b> ${categoryLabel} (id ${categoryId})</div>
          <div><b>Dimensions (HxWxD):</b> ${height}x${width}x${depth} cm</div>
          <div><b>Condition id:</b> ${condition}</div>
          <div><b>Images:</b> ${imageCount}</div>
          ${
            violations.length > 0
              ? `<div class="warn">DBA reports unresolved fields: ${violations.map((v) => v.field).join(", ")}</div>`
              : ""
          }
          <button class="primary" id="dba-agent-publish">Publish listing</button>
          <button class="secondary" id="dba-agent-cancel">Cancel</button>
        `
      );
      document.body.appendChild(el);
      window.__dbaAgentAttachDragAndMinimize(el);

      document.getElementById("dba-agent-publish").addEventListener("click", () => {
        el.remove();
        window.dbaAgentPublishDecision(true);
      });
      document.getElementById("dba-agent-cancel").addEventListener("click", () => {
        el.remove();
        window.dbaAgentPublishDecision(false);
      });
    },
    {
      itemId,
      title,
      price,
      postalCode,
      categoryId,
      categoryLabel,
      height,
      width,
      depth,
      condition,
      imageCount: uploadedImages.length,
      violations: remainingViolations,
    }
  );

  while (decision === null) {
    await page.waitForTimeout(500);
  }
  return decision;
}

async function deleteItem(request, itemId) {
  try {
    await request.delete(`https://www.dba.dk/ads/${itemId}`);
  } catch {
    // best-effort cleanup; an abandoned scratch draft is harmless
  }
}

// Phase 1 — Discover. Creates a throwaway scratch item purely to see what
// DBA actually wants for this product (category suggestion, and whatever
// the validate/draft-save `violations` reveal is still required once a
// category is set), decides every field it can from the product's own
// title/description, asks the user in-page for anything it can't, then
// deletes the scratch item. Nothing here is the real listing.
async function discoverFields(page, request, title, description) {
  await showStatus(page, "Discovery: starting a scratch draft to see what DBA needs for this item…");
  const scratchItemId = await startNewDraft(page, request, null);

  await showStatus(page, "Discovery: asking DBA to suggest a category…");
  const { categoryId, categoryLabel } = await resolveCategory(page, request, scratchItemId, title);

  const { height, width, depth, condition } = await collectAttributes(page, title, description, categoryLabel);

  await showStatus(page, "Discovery: cleaning up the scratch draft…");
  await deleteItem(request, scratchItemId);

  return { categoryId, categoryLabel, height, width, depth, condition };
}

// Phase 2 — Fill. All fields are already decided at this point; this
// creates the real item and fills it in one pass via the API, with no more
// field-collection panels — only the final publish confirmation remains.
async function fillAndPublish(page, request, product, postalCode, fields) {
  const { title, description, price, images } = product;
  const { categoryId, categoryLabel, height, width, depth, condition } = fields;

  await showStatus(page, "Starting the real listing draft…");
  const itemId = await startNewDraft(page, request, postalCode);
  console.log(`DBA item id: ${itemId}`);

  await showStatus(page, `Uploading ${images.length} photo(s)…`);
  const uploadedImages = images.length > 0 ? await uploadImages(request, itemId, images) : [];

  const data = {
    trade_type: "SELL",
    category: categoryId,
    height,
    width,
    depth,
    condition,
    cartiresandrims: {},
    title,
    description,
    price: { price_amount: price },
    address: { postalcode: postalCode, country: "DK" },
    image: uploadedImages,
  };

  await showStatus(page, "Saving draft…");
  const draftResult = await saveDraft(request, itemId, data);

  console.log("Waiting for publish confirmation in the browser panel...");
  const confirmed = await reviewDraftWithUser(page, itemId, draftResult, {
    title,
    price,
    postalCode,
    categoryId,
    categoryLabel,
    height,
    width,
    depth,
    condition,
    uploadedImages,
  });
  if (!confirmed) {
    throw new Error("user cancelled before publishing");
  }

  await showStatus(page, "Publishing…");
  const publishRes = await request.put(`https://www.dba.dk/recommerce/create/api/item/${itemId}`, {
    data: { commit: true, data },
  });
  if (!publishRes.ok()) {
    throw new Error(`publish failed: HTTP ${publishRes.status()}`);
  }

  await request.post(`https://www.dba.dk/recommerce/delivery/api/delivery?finnkode=${itemId}`, {
    data: { meetup: true, shipping: false },
  });

  return `https://www.dba.dk/my-items/details/${itemId}`;
}

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.log("ERROR missing product JSON argument");
    process.exit(1);
  }

  let product;
  try {
    product = JSON.parse(raw);
  } catch (err) {
    console.log(`ERROR invalid product JSON: ${err.message}`);
    process.exit(1);
  }

  const { title, description, images = [] } = product;
  const postalCode = process.env.DBA_SELLER_POSTAL_CODE;

  if (!postalCode) {
    console.log("ERROR DBA_SELLER_POSTAL_CODE is not set in .env");
    process.exit(1);
  }

  for (const imagePath of images) {
    if (!fs.existsSync(imagePath)) {
      console.log(`ERROR image not found: ${imagePath}`);
      process.exit(1);
    }
  }

  let browser;

  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    const request = context.request;

    await page.goto("https://www.dba.dk/");
    console.log("Waiting for login (complete it in the browser window)...");
    await waitForLogin(page);
    console.log("Logged in.");

    console.log("Phase 1: discovering required fields via a scratch draft...");
    const fields = await discoverFields(page, request, title, description);
    console.log(
      `Discovered — category: ${fields.categoryLabel} (id ${fields.categoryId}), ` +
        `dimensions: ${fields.height}x${fields.width}x${fields.depth} cm, condition id: ${fields.condition}`
    );
    // Machine-parseable, printed unconditionally (before the fill/publish
    // step that can still fail) so callers can persist the discovered
    // fields back into their own state even on a failed run — discovery
    // succeeding is real, reusable information regardless of what happens
    // to the actual listing afterward.
    console.log(`FIELDS ${JSON.stringify(fields)}`);

    console.log("Phase 2: filling the real listing...");
    const listingUrl = await fillAndPublish(page, request, product, postalCode, fields);

    console.log(`POSTED ${listingUrl}`);
    await browser.close();
  } catch (err) {
    console.log(`ERROR ${err.message}`);
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
    process.exit(1);
  }
}

main();
