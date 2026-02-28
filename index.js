const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");

puppeteer.use(StealthPlugin());

const COOKIES_FILE = "epic-cookies.json";
const BASE_URL = "https://store.epicgames.com";
const STORE_URL = `${BASE_URL}/en-US/free-games`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Cookies ──────────────────────────────────────────────
async function saveCookies(page) {
  const cookies = await page.cookies();
  if (!cookies.length) return;

  const sameSiteMap = { None: "no_restriction", Lax: "lax", Strict: "strict" };
  const formatted = cookies.map((c) => ({
    ...c,
    sameSite: sameSiteMap[c.sameSite] ?? "no_restriction",
    expirationDate: c.expires > 0 ? c.expires : undefined,
    session: !c.expires || c.expires <= 0,
  }));

  fs.writeFileSync(COOKIES_FILE, JSON.stringify(formatted, null, 2));
  console.log(`💾 Cookies saved (${cookies.length}).`);
}

async function loadCookies(page) {
  const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, "utf-8"));
  await page.goto("https://www.epicgames.com", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const sameSiteMap = { no_restriction: "None", lax: "Lax", strict: "Strict" };
  for (const c of cookies) {
    try {
      await page.setCookie({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        httpOnly: c.httpOnly || false,
        secure: c.secure || false,
        ...(sameSiteMap[c.sameSite]
          ? { sameSite: sameSiteMap[c.sameSite] }
          : {}),
        ...(c.expirationDate ? { expires: Math.floor(c.expirationDate) } : {}),
      });
    } catch (e) {
      console.warn(`⚠️  Skipping cookie "${c.name}": ${e.message}`);
    }
  }
  console.log(`✅ ${cookies.length} cookies loaded.`);
}

// ── Session ───────────────────────────────────────────────
async function refreshSession(page) {
  console.log("🔄 Refreshing session...");
  await page.goto(BASE_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await sleep(2000);

  const ok = await page.evaluate(() => !location.href.includes("/login"));
  if (ok) {
    console.log("✅ Session valid.");
    await saveCookies(page);
  } else console.log("❌ Session expired. Export new cookies from browser.");
  return ok;
}

// ── Free Games ────────────────────────────────────────────
async function getFreeNowGames(page) {
  console.log("🌐 Opening Free Games page...");
  await page.goto(STORE_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForSelector('[data-component="FreeOfferCard"]', {
    visible: true,
    timeout: 20000,
  });
  await sleep(3000);

  return page.evaluate(() =>
    [...document.querySelectorAll('[data-component="FreeOfferCard"]')].reduce(
      (acc, card) => {
        const link = card.querySelector("a[aria-label]");
        if (
          !link ||
          !link.getAttribute("aria-label").toLowerCase().includes("free now")
        )
          return acc;
        acc.push({
          title:
            card.querySelector("h6")?.innerText.trim() ??
            link.getAttribute("aria-label"),
          href: link.getAttribute("href"),
        });
        return acc;
      },
      [],
    ),
  );
}

// ── Claim ─────────────────────────────────────────────────
async function waitForPurchaseFrame(page, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const btn = await frame.$(".payment-btn.payment-order-confirm__btn");
        if (btn) return { frame, btn };
      } catch {}
    }
    await sleep(500);
  }
  return null;
}

async function claimGame(page, game) {
  const slug = game.title.replace(/[^a-z0-9]/gi, "_");
  const ss = (label) => page.screenshot({ path: `ss_${slug}_${label}.png`, fullPage: true });

  console.log(`\n➡️  [${game.title}]\n   URL: ${BASE_URL + game.href}`);
  await page.goto(BASE_URL + game.href, { waitUntil: "networkidle2", timeout: 30000 });

  try {
    await page.waitForSelector('[data-testid="purchase-cta-button"]', { visible: true, timeout: 15000 });
  } catch {
    await ss("1_no_get_btn");
    return console.log(`   ⚠️  "Get" button not found, skipping.`);
  }

  await sleep(1000);
  const getBtn = await page.$('[data-testid="purchase-cta-button"]');
  const btnText = await page.evaluate((el) => el.innerText.trim(), getBtn);
  console.log(`   🔘 Button: "${btnText}"`);

  if (/in library/i.test(btnText)) return console.log(`   ✅ Already in library.`);
  if (!/get/i.test(btnText))       return console.log(`   ⚠️  Unexpected button "${btnText}", skipping.`);

  await ss("2_before_get_click");
  await getBtn.click();
  console.log(`   🖱️  Clicked "Get"`);

  await sleep(2000);
  await ss("3_after_get_click");

  // Handle possible ToS checkbox
  try {
    const checkbox = await page.$('input[type="checkbox"]');
    if (checkbox) { await checkbox.click(); console.log("   ☑️  ToS checkbox clicked"); await sleep(500); }
  } catch {}

  console.log('   ⏳ Waiting for "Place Order" modal...');
  const result = await waitForPurchaseFrame(page, 15000);

  if (!result) {
    await ss("4_no_modal");
    return console.log(`   ⚠️  "Place Order" modal not found.`);
  }

  await ss("5_modal_found");
  console.log(`   ✅ Modal found.`);

  try {
    await result.frame.evaluate(() => {
      document.body.style.border = "3px solid red"; 
    });
  } catch {}

  await sleep(1000);
  await result.btn.click();
  console.log(`   🖱️  Clicked "Place Order"`);

  await sleep(2000);
  await ss("6_after_place_order");
  await sleep(3000);
  await ss("7_final_state");

  // Verify claim
  let claimed = false;
  try {
    await page.waitForFunction(
      () => /in library/i.test(document.querySelector('[data-testid="purchase-cta-button"]')?.innerText ?? ""),
      { timeout: 15000 }
    );
    claimed = true;
  } catch {
    try {
      await page.waitForSelector(
        '[data-component="SuccessMessage"], .success-message, [class*="success"]',
        { timeout: 5000 }
      );
      claimed = true;
    } catch {}
  }

  await ss("8_verify_result");
  console.log(claimed ? `   🎉 "${game.title}" claimed! (VERIFIED)` : `   ❌ "${game.title}" UNVERIFIED`);
  await saveCookies(page);
  await sleep(2000);
}

// ── Verify Purchases ──────────────────────────────────────
async function verifyPurchases(page, titles) {
  console.log("\n🔍 Verifying purchases...");
  await page.goto("https://www.epicgames.com/account/transactions/purchases", {
    waitUntil: "networkidle2",
    timeout: 30000,
  });
  await sleep(3000);

  const text = (
    await page.evaluate(() => document.body.innerText)
  ).toLowerCase();
  for (const title of titles) {
    const found = text.includes(title.toLowerCase());
    console.log(
      `   ${found ? "✅" : "❌"} ${title}: ${found ? "FOUND" : "NOT FOUND"}`,
    );
  }
}

// ── Main ──────────────────────────────────────────────────
(async () => {
  if (!fs.existsSync(COOKIES_FILE)) {
    console.error(`❌ "${COOKIES_FILE}" not found!`);
    process.exit(1);
  }

  const isCI = process.env.GITHUB_ACTIONS === "true";

  const browser = await puppeteer.launch({
    headless: isCI ? "new" : false,

    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,

    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      isCI ? "--single-process" : null,
    ].filter(Boolean),
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  );
  await page.setViewport({ width: 1280, height: 800 });

  await loadCookies(page);

  if (!(await refreshSession(page))) {
    console.log(
      "\n⚠️  Please:\n   1. Open store.epicgames.com\n   2. Log in\n   3. Export cookies → epic-cookies.json",
    );
    await browser.close();
    process.exit(1);
  }

  const games = await getFreeNowGames(page);
  if (!games.length) {
    console.log("\nℹ️  No Free Now games available.");
    await browser.close();
    return;
  }

  console.log(`\n🎮 ${games.length} game(s) found:`);
  games.forEach((g, i) => console.log(`  ${i + 1}. ${g.title} → ${g.href}`));

  for (const game of games) await claimGame(page, game);

  await verifyPurchases(
    page,
    games.map((g) => g.title),
  );

  console.log("\n✅ Done!");
  await browser.close();
})();