// Posts one listing to DBA.dk purely by driving the real DBA UI through
// Playwright — no DBA API calls anywhere in this file. This is a deliberate
// change from an earlier API-hybrid version: DBA's create-item form shows a
// different set of fields depending on which category is picked (e.g. a
// furniture category has Højde/Bredde/Dybde/Stand, an equipment category
// like "Erhvervskøkken og restaurant" has neither), and there is no API to
// list that mapping ahead of time — DBA's own category taxonomy lives only
// in its frontend bundle. So instead of trying to predict the field set,
// this script discovers it live from the rendered DOM, one field at a time,
// re-scanning after every fill (picking a category can make DBA render
// brand-new fields that didn't exist a moment ago).
//
// Because the caller (an agent) needs to ask a human, in chat, what value to
// put in each discovered field — and a Node script can't itself prompt an
// agent's chat UI — this script cannot run start-to-finish on its own. It's
// split into small commands run against one persistent browser session:
//
//   node scripts/post_dba.js server              start the browser + a local
//                                                 HTTP command server, then idle
//   node scripts/post_dba.js start '<product-json>'
//   node scripts/post_dba.js scan
//   node scripts/post_dba.js fill '<field-name>' '<value>'
//   node scripts/post_dba.js publish
//   node scripts/post_dba.js stop
//
// `server` launches one headed Chromium browser and an HTTP server on
// 127.0.0.1 (port written to .auth/dba-server.port, gitignored) and then
// waits for commands. Every other subcommand is a short-lived process that
// POSTs to that server and prints its JSON response to stdout — this is how
// a caller drives the flow one step at a time across separate process
// invocations while keeping the same browser tab (and its in-progress,
// not-yet-saved form state) alive throughout.
//
// Intended driving loop (by the caller, e.g. an agent):
//   start(product) -> repeat { scan(); if not done: ask the user for a
//   value for the returned field (showing its live dropdown options, if
//   any); fill(field, value) } until scan() reports done -> publish() ->
//   stop()
//
// `publish` clicks DBA's own "Se forhåndsvisning" (preview) button and
// returns immediately — it does not wait for or confirm an actual publish.
// Completing the submit inside DBA's preview screen is the user's job from
// that point on; this script's job ends at the preview click.
//
// Draft reuse: `start` first checks DBA's own "Mine annoncer" page for an
// existing item whose title exactly matches the product being posted, and
// resumes it if found — DBA's "create a new listing" flow always resumes
// the one in-progress draft per account rather than minting a fresh item on
// every visit, so blindly creating "new" risks colliding with an unrelated
// in-progress draft (hit in practice 2026-08-28, see SKILL.md). Only when no
// title match exists does it go through the Markedspladsen "new listing"
// click to mint a genuinely fresh item.
//
// All user-facing waits (login, "Mine annoncer" title check being visibly
// slow, etc.) show a small status overlay injected into the DBA page itself
// — not terminal prompts. A terminal readline prompt run through an agent's
// sandboxed shell can leave keystrokes never reaching a background
// process's stdin, hanging with no visible symptom; an in-page overlay
// sidesteps that entirely since it's just page content the user is already
// looking at (for `start`'s login wait) or, for scan/fill, values that
// arrive over the same local HTTP server as everything else.
//
// On any command failure, the server responds with a non-200 status and a
// JSON body `{error: message}`; the short-lived CLI process prints
// `ERROR <message>` and exits 1.

require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");

const AUTH_DIR = path.join(__dirname, "..", ".auth");
const AUTH_FILE = path.join(AUTH_DIR, "dba.json");
const PORT_FILE = path.join(AUTH_DIR, "dba-server.port");

const OVERLAY_CSS = `
  #dba-agent-overlay { position: fixed; top: 16px; right: 16px; z-index: 2147483647;
    width: 340px; background: #fff; color: #111; border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.35); font-family: -apple-system, sans-serif;
    font-size: 13px; padding: 16px; max-height: 90vh; overflow-y: auto; }
  #dba-agent-overlay h2 { margin: 0 0 10px; font-size: 14px; }
  #dba-agent-overlay .hint { color: #666; font-size: 12px; margin-top: 4px; }
  #dba-agent-overlay button.primary { margin-top: 12px; padding: 8px 14px; border-radius: 6px;
    border: none; font-size: 13px; font-weight: 600; cursor: pointer; width: 100%;
    background: #0a6cff; color: #fff; }
`;

async function injectOverlay(page) {
  try {
    await page.addStyleTag({ content: OVERLAY_CSS });
  } catch {
    // page mid-navigation; caller retries via its own status/panel refresh
  }
}

async function showStatus(page, message) {
  await injectOverlay(page);
  try {
    await page.evaluate((message) => {
      let el = document.getElementById("dba-agent-overlay");
      if (!el) {
        el = document.createElement("div");
        el.id = "dba-agent-overlay";
        document.body.appendChild(el);
      }
      el.innerHTML = `<h2>Blue Cross Agent</h2><div class="hint">${message}</div>`;
    }, message);
  } catch {
    // page mid-navigation; not worth retrying for a transient status line
  }
}

const LOGIN_OVERLAY_MARKUP = `
  <h2>Blue Cross Agent</h2>
  <div class="hint">Log in to DBA in this window (or resume an existing session), then click below.</div>
  <button class="primary" id="dba-agent-login-done">I'm logged in, continue</button>
`;

// Real evidence of an authenticated session rather than guessing at cookie
// names or DOM structure: navigate to DBA's own listings page
// (https://www.dba.dk/my-items — confirmed against the live site; an
// earlier guess at /mypage/my-ads was wrong and 404s) and check where it
// actually lands. A logged-out session gets redirected off dba.dk entirely
// (DBA's login lives on a separate domain, e.g. login.vend.dk) — checking
// the final hostname after the navigation settles is far more reliable
// than looking for login-prompt text on a page that may still be
// mid-render or mid-redirect.
async function isLoggedIn(page) {
  try {
    await page.goto("https://www.dba.dk/my-items", { waitUntil: "networkidle", timeout: 20000 });
    return new URL(page.url()).hostname === "www.dba.dk";
  } catch {
    return false;
  }
}

// Login can involve DBA navigating the page (redirects through id.dba.dk and
// back), which destroys any pending page.evaluate()'s JS execution context.
// This waits by polling a Node-side flag set via an exposed function, and
// re-injects the overlay on every navigation rather than relying on a
// single long-lived evaluate call.
async function waitForLogin(page) {
  if (await isLoggedIn(page)) {
    console.error("Resumed a saved login session — no need to log in again.");
    return;
  }

  await page.goto("https://www.dba.dk/");

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

// DBA's "create a new listing" flow always resumes the one in-progress
// draft per account rather than minting a fresh item on every visit (see
// file header). Checking "Mine annoncer" for a title match first means: if
// there's already an in-progress draft for THIS product, resume it instead
// of risking a collision with an unrelated draft.
async function findExistingDraftUrlByTitle(page, title) {
  // statusFacetId=DRAFT narrows "Mine annoncer" to in-progress drafts only —
  // confirmed against the live site (2026-08-29) — since a resumable draft
  // is specifically what this is looking for, not any listing status.
  await page.goto("https://www.dba.dk/my-items?statusFacetId=DRAFT", { waitUntil: "networkidle" });
  await page.waitForTimeout(1000); // let the client-rendered list populate

  const link = page.locator("a", { hasText: title }).first();
  if ((await link.count()) === 0) return null;

  const href = await link.getAttribute("href");
  if (!href) return null;

  // The list links to /my-items/details/{itemId} — a read-only view page
  // (confirmed empty of form fields), not the editable draft form. Extract
  // the item id and build the real edit URL, same pattern the item id
  // itself resolves to after /create-item/start (see startNewDraft).
  const idMatch = /\/my-items\/details\/(\d+)/.exec(href);
  if (!idMatch) return null;
  return `https://www.dba.dk/recommerce/create/${idMatch[1]}`;
}

async function startNewDraft(page) {
  await page.goto("https://www.dba.dk/create-item/start", { waitUntil: "networkidle" });

  // /create-item/start shows a two-way choice (Markedspladsen vs Motor)
  // before it will show the item form. This script only ever posts regular
  // marketplace items, so it always picks Markedspladsen; if that option
  // isn't there, fall through and let the caller see whatever DBA shows.
  try {
    await page.getByText("Markedspladsen", { exact: false }).first().click({ timeout: 10000 });
  } catch {
    // no such option on this screen — maybe DBA already skipped straight
    // to the item form, or the screen looks different than expected
  }
  await page.waitForLoadState("networkidle").catch(() => {});
}

// Uploads images through DBA's own "Tilføj billeder" file input — the only
// reliable way found for this step (a direct API upload returned an
// unexplained HTTP 500 in an earlier version of this script; driving the
// real input sidesteps that by doing exactly what a human does).
async function uploadImages(page, images) {
  if (images.length === 0) return;
  const fileInput = page.locator('input[type="file"]').first();
  const absolutePaths = images.map((imagePath) => path.resolve(imagePath));
  try {
    await fileInput.waitFor({ state: "attached", timeout: 15000 });
  } catch {
    throw new Error(
      `no file input found on the page after 15s (currently on ${page.url()}) — DBA may not have reached the item form yet, e.g. still on a login/redirect page`
    );
  }
  await fileInput.setInputFiles(absolutePaths);
  // Give DBA's frontend a moment to finish processing the upload (thumbnail
  // rendering, etc.) before any further navigation/interaction.
  await page.waitForTimeout(2000);
}

// Tries a field by accessible label first, then by ARIA role+name as a
// fallback — DBA's exact markup for label association isn't confirmed for
// every field, so this doesn't assume getByLabel alone is enough.
async function locateField(page, name) {
  const candidates = [
    page.getByLabel(name, { exact: false }),
    page.getByRole("textbox", { name, exact: false }),
    page.getByRole("spinbutton", { name, exact: false }),
    page.getByRole("combobox", { name, exact: false }),
  ];
  for (const locator of candidates) {
    if ((await locator.count()) > 0) {
      return locator.first();
    }
  }
  return null;
}

function isEmptyValue(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

// Scans every labeled, visible, enabled form field currently rendered on
// the page, in document order, and returns the first one that's still
// empty. Deliberately re-derives this list from scratch on every call
// (never cached) — picking a category (or any other field) can make DBA
// render brand-new fields that weren't in the DOM a moment ago, and this is
// the only way the caller's ask-fill loop picks those up.
async function scanNextEmptyField(page) {
  // Plain locator, no .filter({has: ":visible"}) — that filter checks for a
  // visible *descendant*, which a leaf input/select/textarea never has, so
  // it silently matched almost nothing. Visibility is checked per-element
  // below instead (el.isVisible()), which is the correct way to test the
  // element itself rather than its children.
  const controls = page.locator("main input, main select, main textarea");
  const count = await controls.count();

  for (let i = 0; i < count; i++) {
    const el = controls.nth(i);

    if (!(await el.isVisible().catch(() => false))) continue;
    if (!(await el.isEnabled().catch(() => false))) continue;

    const type = await el.getAttribute("type").catch(() => null);
    if (type === "hidden" || type === "file" || type === "checkbox" || type === "radio") continue;

    const name = await accessibleName(page, el);
    if (!name) continue; // can't ask the user about a field with no discoverable label

    const tagName = await el.evaluate((node) => node.tagName.toLowerCase());

    if (tagName === "select") {
      const value = await el.inputValue().catch(() => "");
      if (!isEmptyValue(value)) continue;
      const options = await el.locator("option").allTextContents();
      return {
        done: false,
        field: { name, type: "select", options: options.map((o) => o.trim()).filter(Boolean) },
      };
    }

    const value = await el.inputValue().catch(() => "");
    if (!isEmptyValue(value)) continue;
    return { done: false, field: { name, type: type === "number" ? "number" : "text" } };
  }

  return { done: true };
}

// Resolves a field's accessible name the same way locateField finds it, so
// scan's field names always round-trip into a working fill() call.
async function accessibleName(page, el) {
  const id = await el.getAttribute("id").catch(() => null);
  if (id) {
    const label = page.locator(`label[for="${id}"]`);
    if ((await label.count()) > 0) {
      const text = (await label.first().textContent())?.trim();
      if (text) return text;
    }
  }
  const ariaLabel = await el.getAttribute("aria-label").catch(() => null);
  if (ariaLabel) return ariaLabel.trim();
  const placeholder = await el.getAttribute("placeholder").catch(() => null);
  if (placeholder) return placeholder.trim();
  return null;
}

async function fillField(page, name, value) {
  const locator = await locateField(page, name);
  if (!locator) {
    throw new Error(`could not find a "${name}" field on DBA's form`);
  }
  const tagName = await locator.evaluate((node) => node.tagName.toLowerCase());
  if (tagName === "select") {
    await locator.selectOption({ label: value });
  } else {
    await locator.fill(String(value));
  }
}

// Prefills the fields already known from products.json/.env directly,
// without going through the ask-the-user scan/fill loop. These are
// best-effort (a field DBA doesn't render for the current form state is
// skipped, not an error) since which fields exist at this point in the flow
// isn't guaranteed.
async function prefillKnownFields(page, product, postalCode) {
  const description = [product.description_da, product.description_en].filter(Boolean).join("\n\n");
  const known = [
    ["Annonceoverskrift", product.title],
    ["Beskrivelse", description],
    ["Pris", product.price],
    ["Postnummer", postalCode],
  ];
  for (const [name, value] of known) {
    if (isEmptyValue(value)) continue;
    try {
      await fillField(page, name, value);
    } catch {
      // not on the page yet at this point in the flow — the scan/fill loop
      // will surface it later as an empty field if it turns out to matter
    }
  }
}

async function clickPreview(page) {
  const button = page.getByRole("button", { name: "Se forhåndsvisning", exact: false });
  await button.click({ timeout: 10000 });
}

// --- HTTP command server -----------------------------------------------

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function runServer() {
  let browser;
  let page;

  const context0 = await chromium
    .launch({ headless: false })
    .then(async (b) => {
      browser = b;
      const hasSavedSession = fs.existsSync(AUTH_FILE);
      return b.newContext(hasSavedSession ? { storageState: AUTH_FILE } : {});
    });
  page = await context0.newPage();

  const server = http.createServer(async (req, res) => {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: `invalid JSON body: ${err.message}` });
      return;
    }

    try {
      switch (req.url) {
        case "/start": {
          const { product, postalCode } = body;
          if (!postalCode) throw new Error("DBA_SELLER_POSTAL_CODE is not set in .env");

          await waitForLogin(page);
          fs.mkdirSync(AUTH_DIR, { recursive: true });
          await context0.storageState({ path: AUTH_FILE });

          await showStatus(page, `Checking "Mine annoncer" for an existing draft titled "${product.title}"…`);
          const existingUrl = await findExistingDraftUrlByTitle(page, product.title);
          if (existingUrl) {
            console.error(`Found an existing DBA draft titled "${product.title}" — resuming it.`);
            await page.goto(existingUrl, { waitUntil: "domcontentloaded" });
          } else {
            await startNewDraft(page);
          }

          await showStatus(page, `Uploading ${product.images.length} photo(s)…`);
          await uploadImages(page, product.images);

          await showStatus(page, "Filling in the fields we already know…");
          await prefillKnownFields(page, product, postalCode);

          await showStatus(page, "Ready — Claude will now ask you for any remaining fields.");
          sendJson(res, 200, { ok: true });
          return;
        }
        case "/scan": {
          const result = await scanNextEmptyField(page);
          sendJson(res, 200, result);
          return;
        }
        case "/fill": {
          const { field, value } = body;
          await fillField(page, field, value);
          sendJson(res, 200, { ok: true });
          return;
        }
        case "/publish": {
          await showStatus(
            page,
            "All fields filled. Clicking DBA's preview button — please review and publish yourself from there."
          );
          await clickPreview(page);
          sendJson(res, 200, { ok: true });
          return;
        }
        case "/stop": {
          sendJson(res, 200, { ok: true });
          res.on("finish", async () => {
            await browser.close();
            try {
              fs.unlinkSync(PORT_FILE);
            } catch {
              // already gone
            }
            process.exit(0);
          });
          return;
        }
        default:
          sendJson(res, 404, { error: `unknown command: ${req.url}` });
      }
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });

  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(PORT_FILE, String(port));
    console.error(`DBA agent server listening on 127.0.0.1:${port}`);
  });
}

// --- CLI: short-lived commands that talk to the running server ----------

function readPort() {
  if (!fs.existsSync(PORT_FILE)) {
    throw new Error(`no running DBA agent server found (${PORT_FILE} missing) — run "server" first`);
  }
  return Number.parseInt(fs.readFileSync(PORT_FILE, "utf8").trim(), 10);
}

function postCommand(port, url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body ?? {});
    const req = http.request(
      { host: "127.0.0.1", port, path: url, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            reject(new Error(`non-JSON response from server: ${raw.slice(0, 300)}`));
            return;
          }
          if (res.statusCode >= 400) {
            reject(new Error(parsed.error || `server returned HTTP ${res.statusCode}`));
            return;
          }
          resolve(parsed);
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function runClientCommand(command, args) {
  const port = readPort();

  switch (command) {
    case "start": {
      const raw = args[0];
      if (!raw) throw new Error("missing product JSON argument");
      const product = JSON.parse(raw);
      for (const imagePath of product.images || []) {
        if (!fs.existsSync(imagePath)) throw new Error(`image not found: ${imagePath}`);
      }
      const postalCode = process.env.DBA_SELLER_POSTAL_CODE;
      const result = await postCommand(port, "/start", { product, postalCode });
      console.log(JSON.stringify(result));
      return;
    }
    case "scan": {
      const result = await postCommand(port, "/scan");
      console.log(JSON.stringify(result));
      return;
    }
    case "fill": {
      const [field, value] = args;
      if (!field || value === undefined) throw new Error("usage: fill '<field-name>' '<value>'");
      const result = await postCommand(port, "/fill", { field, value });
      console.log(JSON.stringify(result));
      return;
    }
    case "publish": {
      const result = await postCommand(port, "/publish");
      console.log(JSON.stringify(result));
      return;
    }
    case "stop": {
      const result = await postCommand(port, "/stop");
      console.log(JSON.stringify(result));
      return;
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command) {
    console.log("ERROR missing command (server|start|scan|fill|publish|stop)");
    process.exit(1);
  }

  if (command === "server") {
    await runServer();
    return; // stays alive; process.exit happens from the /stop handler
  }

  try {
    await runClientCommand(command, args);
  } catch (err) {
    console.log(`ERROR ${err.message}`);
    process.exit(1);
  }
}

main();
