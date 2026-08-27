// Posts one listing to DBA.dk using a mix of DBA's own recommerce
// create-item JSON API (for the steps that turned out to work reliably)
// and driving DBA's real form/buttons directly for the steps that didn't.
//
// Usage: node scripts/post_dba.js '{"title":"...","description":"...","price":999,"images":["products/x/img/a.jpg"]}'
//
// Reverse-engineered from a real posting flow captured with Playwright's
// network recorder (2026-08-27), then corrected repeatedly by testing
// against the live form as parts of the pure-API approach turned out not
// to work in practice (see the two big notes below and the ones near
// uploadImages()/fillRemainingFieldsViaForm() further down):
//   - GET  /recommerce/create/api/user/postalcode        account default postal code
//   - PUT  /recommerce/create/api/item/{id}/validate      creates the draft, returns missing fields
//   - PUT  /recommerce/create/api/item/{id}               {commit:false, data:{address}} must happen
//     at least once BEFORE the first image upload — uploading straight after
//     validate returns HTTP 500.
//   - Image upload: driven through DBA's real file input, NOT a direct API
//     call — see the note on uploadImages() for why.
//   - POST /recommerce/create/api/predictions/categories/{id}   AI category suggestion from title/image
//   - Title/description/price/postal code: filled through DBA's real form
//     fields, NOT a direct API draft-save call — see the note on
//     fillRemainingFieldsViaForm() for why.
//   - Publish: the user clicks DBA's own "Se forhåndsvisning" button and
//     completes publishing themselves in DBA's UI; this script detects
//     success by polling GET /my-items/details/{id}/api/single?adId={id}
//     for the item's state leaving DRAFT.
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
// Creates exactly one DBA item and fills it progressively — there is no
// separate throwaway "discovery" item. An earlier version of this script
// tried a two-item design (a scratch item to find out what DBA wants,
// deleted afterward, then a second fresh item for the real listing) but
// DBA's /create-item/start flow turned out to always resume the same one
// in-progress draft per session rather than minting a genuinely new item
// id on a second navigation — so the "fresh" second item was actually the
// same item, sometimes already deleted, causing failures that looked like
// unrelated bugs. Filling one real item from the start avoids that
// scratch/collision problem entirely and matches how a human uses DBA's
// own form anyway (one draft, filled in over several steps).
//
// The flow: create the item, upload photos (needed before asking for a
// category — DBA's classifier has nothing to look at otherwise), get
// DBA's AI category suggestion (or let the user pick one by hand in DBA's
// real form if there's no suggestion), collect height/width/depth/
// condition via an overlay panel (dimensions pre-filled by guessing from
// the product's own title/description text), fill title/description/
// price/postal code into DBA's real form, show a review panel, and wait
// for the user to click "Se forhåndsvisning" and publish in DBA's own UI.
//
// The user is interrupted at: login, the item-details panel, (only if DBA
// had no category suggestion) a manual category pick, and the final review
// panel — where publishing itself happens entirely in DBA's own UI, not
// via anything this script submits on the user's behalf.
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

// Maps products.json's channel-agnostic metadata.condition (set by
// add-product from the description) to DBA's own condition ids.
const CONDITION_LABEL_TO_ID = {
  new: 1,
  like_new: 2,
  used_good: 3,
  used_fair: 4,
  worn: 5,
};

// Resolves the item-details panel's starting values in priority order:
// 1. product.metadata (predicted by add-product from the description and
//    stored in products.json — see add-product's Metadata section), so a
//    prediction made once doesn't need to be re-derived on every post.
// 2. A regex guess against the product's own title/description text.
// 3. Left blank for the user to fill in.
// Either way this is only ever a starting point — the panel always shows
// editable inputs so the user can correct a wrong prediction or guess.
function resolveInitialAttributes(product) {
  const { title, description, metadata } = product;
  const guessed = guessDimensionsFromText(`${title} ${description}`);

  const dims = metadata?.dimensions_cm || {};
  const height = dims.height ?? guessed.height;
  const width = dims.width ?? guessed.width;
  const depth = dims.depth ?? guessed.depth;

  const condition = metadata?.condition ? CONDITION_LABEL_TO_ID[metadata.condition] ?? null : null;

  return { height, width, depth, condition };
}

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

  // Bound once per page (via a flag on window) rather than once per panel
  // render — el.innerHTML gets replaced on every showStatus()/panel
  // transition on the same reused overlay div, which would otherwise
  // re-attach these document-level mousemove/mouseup listeners every time
  // and accumulate duplicates with stale closures over a long run.
  window.__dbaAgentAttachDragAndMinimize = (el) => {
    const handle = el.querySelector("#dba-agent-drag-handle");
    const minimizeBtn = el.querySelector("#dba-agent-minimize");

    minimizeBtn.onclick = () => {
      el.classList.toggle("minimized");
      minimizeBtn.innerHTML = el.classList.contains("minimized") ? "&#43;" : "&#8211;";
    };

    handle.onmousedown = (e) => {
      if (e.target === minimizeBtn) return;
      window.__dbaAgentDragState = { dragging: true, el, offsetX: e.clientX, offsetY: e.clientY };
      const rect = el.getBoundingClientRect();
      window.__dbaAgentDragState.offsetX = e.clientX - rect.left;
      window.__dbaAgentDragState.offsetY = e.clientY - rect.top;
      el.style.right = "auto";
    };

    if (!window.__dbaAgentDragListenersBound) {
      window.__dbaAgentDragListenersBound = true;
      document.addEventListener("mousemove", (e) => {
        const state = window.__dbaAgentDragState;
        if (!state?.dragging) return;
        state.el.style.left = `${e.clientX - state.offsetX}px`;
        state.el.style.top = `${e.clientY - state.offsetY}px`;
      });
      document.addEventListener("mouseup", () => {
        if (window.__dbaAgentDragState) window.__dbaAgentDragState.dragging = false;
      });
    }
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
    <div class="hint">Log in to DBA in this window (or resume an existing session), then click below. Next, the agent will create the listing draft, upload photos, ask DBA to suggest a category, and collect a few remaining details from you.</div>
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
  try {
    await page.evaluate(() => {
      if (typeof window.__dbaAgentWithDragAndMinimize !== "function") {
        throw new Error("overlay helper functions not found on window — injectOverlay may not have run on this page");
      }
      // Reuse the overlay div if one already exists (e.g. a transient
      // showStatus() status line) rather than skipping — an earlier bug
      // here silently left a stale status overlay in place forever because
      // it bailed out on seeing any existing #dba-agent-overlay element.
      let el = document.getElementById("dba-agent-overlay");
      if (!el) {
        el = document.createElement("div");
        el.id = "dba-agent-overlay";
        document.body.appendChild(el);
      }
      el.innerHTML = window.__dbaAgentWithDragAndMinimize(
        "Pick a category",
        `
          <div class="hint">Step 2 of 2 — Category (manual)</div>
          <div class="hint">DBA's AI classifier had no automatic suggestion for this item. Use the Hovedkategori/Underkategori/Produktkategori dropdowns on this page directly (drag this panel out of the way if needed) — this is the real listing draft.</div>
          <div class="hint">This panel is just watching — it will detect your selection and continue automatically once a valid category is saved. No need to click anything here.</div>
        `
      );
      window.__dbaAgentAttachDragAndMinimize(el);
    });
  } catch (err) {
    console.log(`WARNING failed to render 'Pick a category' overlay panel: ${err.message}`);
    console.log("Continuing to poll for a manual category selection anyway — pick one in the visible DBA form.");
  }

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

async function collectAttributes(page, product, categoryLabel) {
  const { title } = product;
  const initial = resolveInitialAttributes(product);
  const hasAnyValue = initial.height !== null || initial.width !== null || initial.depth !== null;
  const fromMetadata = Boolean(product.metadata?.dimensions_cm || product.metadata?.condition);

  let submitted = null;
  await page.exposeFunction("dbaAgentAttributesSubmit", (values) => {
    submitted = values;
  });

  await injectOverlay(page);
  await page.evaluate(
    ({ title, categoryLabel, conditionOptions, initial, hasAnyValue, fromMetadata, defaultConditionId }) => {
      // Reuse any existing overlay div (e.g. a transient showStatus() line)
      // instead of appending a second element with the same id.
      let el = document.getElementById("dba-agent-overlay");
      if (!el) {
        el = document.createElement("div");
        el.id = "dba-agent-overlay";
        document.body.appendChild(el);
      }
      const selectedCondition = initial.condition ?? defaultConditionId;
      let sourceHint;
      if (fromMetadata) {
        sourceHint = "Pre-filled from products.json's predicted metadata — check these before continuing.";
      } else if (hasAnyValue) {
        sourceHint =
          "Pre-filled by guessing from the product's own title/description — check these before continuing, DBA needs them but they aren't tracked in products.json.";
      } else {
        sourceHint = "Couldn't determine these from the product data — please fill them in.";
      }
      el.innerHTML = window.__dbaAgentWithDragAndMinimize(
        "Item details",
        `
          <div class="hint">Step 2 of 2 — Item details</div>
          <div class="hint">Listing: "${title}"</div>
          <div class="hint">Category: ${categoryLabel}</div>
          <div class="hint">${sourceHint} After Continue, the agent will save the draft and show a final review before publishing.</div>
          <div class="row">
            <div><label>Højde (cm)</label><input id="dba-agent-height" type="number" value="${initial.height ?? ""}" /></div>
            <div><label>Bredde (cm)</label><input id="dba-agent-width" type="number" value="${initial.width ?? ""}" /></div>
            <div><label>Dybde (cm)</label><input id="dba-agent-depth" type="number" value="${initial.depth ?? ""}" /></div>
          </div>
          <label>Stand (condition)</label>
          <select id="dba-agent-condition">
            ${conditionOptions
              .map(
                (o) => `<option value="${o.id}" ${o.id === selectedCondition ? "selected" : ""}>${o.label}</option>`
              )
              .join("")}
          </select>
          <button class="primary" id="dba-agent-continue">Continue</button>
          <div class="warn" id="dba-agent-error" style="display:none"></div>
        `
      );
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
      initial,
      hasAnyValue,
      fromMetadata,
      defaultConditionId: DEFAULT_CONDITION_ID,
    }
  );

  while (submitted === null) {
    await page.waitForTimeout(500);
  }
  return submitted;
}

// Uploads images through DBA's own "Tilføj billeder" file input rather
// than calling the image API directly. Two direct-API approaches — the
// standalone Playwright request client, and an in-page fetch() carrying
// every browser-native header/cookie automatically — both got the same
// unexplained, bodyless HTTP 500 on this endpoint, even with a request
// byte-identical to the one known to work from an actual browser tab. That
// rules out a missing header/auth difference; something about server-side
// item state at that point must differ from a real user's flow. Driving
// the real file input sidesteps the mystery entirely by doing exactly what
// a human does — but each file still fires its own
// POST /recommerce/create/api/image/{itemId} request under the hood (same
// endpoint, same {uri,width,height} response shape as the original
// capture), which this captures via waitForResponse rather than trusting
// DBA's own frontend to expose the result any other way.
async function uploadImages(page, itemId, images) {
  const fileInput = page.locator('input[type="file"]').first();
  const absolutePaths = images.map((imagePath) => path.resolve(imagePath));

  const responsesPromise = Promise.all(
    images.map(() =>
      page.waitForResponse(
        (res) => res.url().includes(`/recommerce/create/api/image/${itemId}`) && res.request().method() === "POST",
        { timeout: 30000 }
      )
    )
  );

  await fileInput.setInputFiles(absolutePaths);
  const responses = await responsesPromise;

  const uploaded = [];
  for (const res of responses) {
    if (!res.ok()) {
      const bodyText = await res.text().catch(() => "");
      throw new Error(`image upload failed via file input: HTTP ${res.status()} — ${bodyText.slice(0, 500)}`);
    }
    const body = await res.json();
    uploaded.push({ uri: body.data.uri, width: body.data.width, height: body.data.height, description: "" });
  }
  return uploaded;
}

// Tries a field by accessible label first, then by ARIA role+name as a
// fallback (textbox covers title/description/postal code; spinbutton
// covers numeric inputs like price) — DBA's exact markup for label
// association isn't confirmed, so this doesn't assume getByLabel alone is
// enough to find every field.
async function fillFormField(page, name, value, { numeric = false } = {}) {
  const candidates = [
    page.getByLabel(name, { exact: false }),
    page.getByRole(numeric ? "spinbutton" : "textbox", { name, exact: false }),
  ];
  for (const locator of candidates) {
    if ((await locator.count()) > 0) {
      await locator.first().fill(String(value));
      return locator.first();
    }
  }
  throw new Error(`could not find a "${name}" field on DBA's form`);
}

// Fills title, description, price, postal code, dimensions, and condition
// through DBA's own form fields rather than a direct API draft-save call.
// After browser-driven image upload started succeeding (see uploadImages
// above), the subsequent API draft-save (saveDraft) began failing with an
// unexplained HTTP 400 — DBA's own frontend JS likely persists its own
// draft revision right after a real upload, and a blind API overwrite
// from a separate client conflicts with that state. Filling the rest of
// the form the same way a human would (real inputs, DBA's own
// "Se forhåndsvisning" button) avoids mixing two different clients'
// writes against the same item.
//
// Height/width/depth/condition are collected earlier via the overlay
// panel (collectAttributes) purely to decide what values to use — an
// earlier version of this function forgot to actually write them into
// DBA's Højde/Bredde/Dybde/Stand fields, silently leaving whatever DBA's
// form already had there (e.g. stale values from a previous session
// resuming the same in-progress draft) instead of the confirmed values.
async function fillRemainingFieldsViaForm(page, product, postalCode, dimensions) {
  const { title, description, price } = product;
  const { height, width, depth, condition } = dimensions;

  await fillFormField(page, "Annonceoverskrift", title);
  await fillFormField(page, "Beskrivelse", description);
  await fillFormField(page, "Pris", price, { numeric: true });
  const postalInput = await fillFormField(page, "Postnummer", postalCode, { numeric: true });
  await postalInput.press("Tab");

  await fillFormField(page, "Højde", height, { numeric: true });
  await fillFormField(page, "Bredde", width, { numeric: true });
  await fillFormField(page, "Dybde", depth, { numeric: true });

  const conditionOption = CONDITION_OPTIONS.find((o) => o.id === condition);
  if (conditionOption) {
    const standSelect = page.getByLabel("Stand", { exact: false });
    if ((await standSelect.count()) > 0) {
      await standSelect.selectOption({ label: conditionOption.label });
    }
  }
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

  // DBA's own flow saves an initial draft before it will accept an image
  // upload for the item — skipping straight from validate to an image POST
  // returns HTTP 500. Mirror that sequencing here unconditionally.
  const initialData = { trade_type: "SELL" };
  if (postalCode) {
    initialData.address = { postalcode: postalCode, country: "DK" };
  }
  await request.put(`https://www.dba.dk/recommerce/create/api/item/${itemId}`, {
    data: { commit: false, data: initialData },
  });

  return itemId;
}

// Shows a summary of everything the agent filled in and tells the user to
// review it in the browser, click DBA's own "Se forhåndsvisning" button,
// and complete publishing themselves from there — the agent doesn't drive
// the preview/submit screens since their shape isn't known and clicking
// blindly through an unfamiliar multi-step flow risks a worse outcome than
// asking the user to finish it. This panel is a checkpoint, not a gate the
// agent unlocks: the actual publish happens entirely in DBA's UI, and
// waitForPublished() (called after this returns) is what detects it did.
async function waitForPreviewConfirmation(page, itemId, fields) {
  const { title, price, postalCode, categoryId, categoryLabel, height, width, depth, condition, uploadedImages } =
    fields;

  let acknowledged = false;
  await page.exposeFunction("dbaAgentPreviewAcknowledged", () => {
    acknowledged = true;
  });

  await injectOverlay(page);
  await page.evaluate(
    ({ itemId, title, price, postalCode, categoryId, categoryLabel, height, width, depth, condition, imageCount }) => {
      let el = document.getElementById("dba-agent-overlay");
      if (!el) {
        el = document.createElement("div");
        el.id = "dba-agent-overlay";
        document.body.appendChild(el);
      }
      el.innerHTML = window.__dbaAgentWithDragAndMinimize(
        "Review and publish",
        `
          <div class="hint">The agent has filled everything below. Draft: https://www.dba.dk/recommerce/create/${itemId}</div>
          <div><b>Title:</b> ${title}</div>
          <div><b>Price:</b> ${price} DKK</div>
          <div><b>Postal code:</b> ${postalCode}</div>
          <div><b>Category:</b> ${categoryLabel} (id ${categoryId})</div>
          <div><b>Dimensions (HxWxD):</b> ${height}x${width}x${depth} cm</div>
          <div><b>Condition id:</b> ${condition}</div>
          <div><b>Images:</b> ${imageCount}</div>
          <div class="hint">Check everything in the browser, then click DBA's own "Se forhåndsvisning" button and complete publishing there yourself. Click below once you've published (or are done).</div>
          <button class="primary" id="dba-agent-preview-done">I've published it</button>
        `
      );
      window.__dbaAgentAttachDragAndMinimize(el);

      document.getElementById("dba-agent-preview-done").addEventListener("click", () => {
        el.remove();
        window.dbaAgentPreviewAcknowledged();
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
    }
  );

  while (!acknowledged) {
    await page.waitForTimeout(500);
  }
}

// Polls DBA's own item-status endpoint for confirmation the listing left
// draft state — the same GET the original captured flow showed transition
// from {"state":{"type":"DRAFT"}} to {"state":{"type":"PENDING"}} once a
// real publish went through. This is how success is detected now that
// publishing itself happens in DBA's UI rather than via an API commit:true
// call this script makes directly.
async function waitForPublished(itemId, request) {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const res = await request.get(
      `https://www.dba.dk/my-items/details/${itemId}/api/single?adId=${itemId}`
    );
    if (res.ok()) {
      const body = await res.json();
      const stateType = body?.state?.type;
      if (stateType && stateType !== "DRAFT") {
        return `https://www.dba.dk/my-items/details/${itemId}`;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    `timed out waiting for DBA to show the listing as published (item ${itemId} still shows DRAFT after 5 minutes) — check the browser; if you did publish, the listing may still be fine, just re-check products.json manually`
  );
}

// Creates one DBA item and fills it end to end: upload photos, resolve
// category (DBA's AI suggestion or a manual pick), collect
// dimensions/condition, fill title/description/price/postal code into
// DBA's real form, then wait for the user to review, click DBA's own
// "Se forhåndsvisning" button, and publish in DBA's own UI. Returns
// { listingUrl, fields } once waitForPublished() confirms the item left
// draft state.
async function createAndPublishListing(page, request, product, postalCode) {
  const { title, price, images } = product;

  await showStatus(page, "Starting a new listing draft on DBA…");
  const itemId = await startNewDraft(page, request, postalCode);
  console.log(`DBA item id: ${itemId}`);

  // Images are uploaded before asking for a category — DBA's AI classifier
  // looks at the item's photo, not just its title, and returns no
  // suggestion at all for an item with nothing uploaded yet.
  await showStatus(page, `Uploading ${images.length} photo(s)…`);
  const uploadedImages = images.length > 0 ? await uploadImages(page, itemId, images) : [];

  await showStatus(page, "Asking DBA to suggest a category…");
  const { categoryId, categoryLabel } = await resolveCategory(page, request, itemId, title);

  const { height, width, depth, condition } = await collectAttributes(page, product, categoryLabel);

  console.log(
    `Resolved — category: ${categoryLabel} (id ${categoryId}), dimensions: ${height}x${width}x${depth} cm, condition id: ${condition}`
  );
  // Machine-parseable, printed as soon as these fields are known — before
  // the draft save / publish steps that can still fail — so a caller can
  // persist them into its own state even if the rest of this run fails.
  console.log(`FIELDS ${JSON.stringify({ categoryId, categoryLabel, height, width, depth, condition })}`);

  await showStatus(page, "Filling in the remaining fields…");
  await fillRemainingFieldsViaForm(page, product, postalCode, { height, width, depth, condition });

  await waitForPreviewConfirmation(page, itemId, {
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

  await showStatus(page, "Waiting for DBA to confirm the listing is published…");
  const listingUrl = await waitForPublished(itemId, request);

  return {
    listingUrl,
    fields: { categoryId, categoryLabel, height, width, depth, condition },
  };
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

  const { images = [] } = product;
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

    const { listingUrl } = await createAndPublishListing(page, request, product, postalCode);

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
