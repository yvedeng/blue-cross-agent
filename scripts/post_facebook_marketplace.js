// Posts one listing to Facebook Marketplace via a headed Playwright browser.
//
// Usage: node scripts/post_facebook_marketplace.js '{"title":"...","description_da":"...","description_en":"...","price":999,"images":["products/x/img/a.jpg"]}'
//
// Facebook Marketplace has one description textbox, so description_da and
// description_en are combined into a single field: Danish text, a blank
// line, then English text.
//
// Pauses twice for the user at the keyboard:
//   1. To log in to Facebook by hand, including any 2FA or checkpoint, and
//      reach the Marketplace "create listing" form.
//   2. After autofill, to set category/condition, review every field, and
//      click submit themselves.
//
// On success prints exactly: POSTED <listing_url>
// On any failure prints:      ERROR <message>
//
// Facebook blocks automated browsers more readily than DBA; a failure here
// is not unusual and should be reported plainly, not retried silently.

require("dotenv").config();
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");

function waitForEnter(promptText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

async function fillFirstMatch(page, labelPatterns, value, fieldName, warnings) {
  for (const pattern of labelPatterns) {
    try {
      const locator = page.getByLabel(pattern).first();
      if ((await locator.count()) > 0) {
        await locator.fill(String(value));
        return true;
      }
    } catch {
      // try next pattern
    }
  }
  warnings.push(fieldName);
  return false;
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

  const { title, description_da, description_en, price, images = [] } = product;
  const description = [description_da, description_en].filter(Boolean).join("\n\n");

  const warnings = [];
  let browser;

  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("https://www.facebook.com/marketplace/create/item");

    await waitForEnter(
      "\nLog in to Facebook in the browser window (complete any 2FA/checkpoint), then navigate to the Marketplace 'create listing' form.\nPress Enter here once the form is visible...\n"
    );

    await fillFirstMatch(page, [/title/i], title, "title", warnings);
    await fillFirstMatch(page, [/price/i], price, "price", warnings);
    await fillFirstMatch(page, [/description/i], description, "description", warnings);

    if (images.length > 0) {
      try {
        const fileInput = page.locator('input[type="file"]').first();
        if ((await fileInput.count()) > 0) {
          const absolutePaths = images.map((p) => path.resolve(p));
          await fileInput.setInputFiles(absolutePaths);
        } else {
          warnings.push("images");
        }
      } catch {
        warnings.push("images");
      }
    }

    for (const field of warnings) {
      console.log(`WARNING could not find a ${field} field automatically`);
    }

    await waitForEnter(
      "\nSet category/condition, review every field in the browser (fix anything wrong or missing), then click submit yourself.\nPress Enter here once you have submitted the listing (or close the browser to abort)...\n"
    );

    const listingUrl = page.url();

    if (!listingUrl || listingUrl.includes("/marketplace/create/")) {
      console.log("ERROR could not determine listing URL after submit");
      process.exit(1);
    }

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
