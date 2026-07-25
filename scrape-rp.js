// scrape-rp.js — logs into racingpost.com, pulls today's racecards, and
// POSTs runner-level RP data (RPR/TS/forecast odds/trainer RTF/tips) to
// the saverpdata backend action, mirroring scrape.js's saveformdata pattern.
//
// FIRST-RUN CAVEAT: RP's exact login form and racecard DOM structure were
// not directly inspectable while writing this (no live browser access to
// racingpost.com from the authoring environment). Selectors below are
// best-effort with fallbacks and heavy debug logging/screenshots so the
// first Actions run tells us what needs adjusting — same approach that
// got the horseracing.net scraper working.
//
// Runs via Puppeteer in GitHub Actions.

const puppeteer = require('puppeteer');
const fs = require('fs');

const RP_EMAIL = process.env.RP_EMAIL;
const RP_PASSWORD = process.env.RP_PASSWORD;
const LIVE_URL = process.env.APPS_SCRIPT_URL;
const DEV_URL = process.env.APPS_SCRIPT_URL_DEV;

if (!RP_EMAIL || !RP_PASSWORD) {
  console.error('ERROR: RP_EMAIL / RP_PASSWORD environment variables not set');
  process.exit(1);
}
if (!LIVE_URL) {
  console.error('ERROR: APPS_SCRIPT_URL environment variable not set');
  process.exit(1);
}

// TARGET_URLS: always includes LIVE, includes DEV only if the secret exists.
const TARGET_URLS = [{ name: 'LIVE', url: LIVE_URL }];
if (DEV_URL) TARGET_URLS.push({ name: 'DEV', url: DEV_URL });
else console.log('APPS_SCRIPT_URL_DEV not set — DEV will be skipped.');

function todayISODate() {
  // UK date, since that's what the sheet keys on (Europe/London)
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(new Date()); // en-CA gives YYYY-MM-DD
}

async function saveDebugArtifact(page, label) {
  try {
    await page.screenshot({ path: `debug-rp-${label}.png`, fullPage: true });
    const html = await page.content();
    fs.writeFileSync(`debug-rp-${label}.html`, html.slice(0, 200000)); // cap size
    console.log(`  Saved debug-rp-${label}.png / .html`);
  } catch (e) {
    console.log(`  Could not save debug artifact for ${label}:`, e.message);
  }
}

function sendJSON(targetUrl, payload) {
  const https = require('https');
  const url = new URL(targetUrl);
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location);
          const req2 = https.request({
            hostname: redirectUrl.hostname,
            path: redirectUrl.pathname + redirectUrl.search,
            method: 'GET'
          }, (res2) => {
            let data2 = '';
            res2.on('data', chunk => data2 += chunk);
            res2.on('end', () => resolve({ status: res2.statusCode, body: data2 }));
          });
          req2.on('error', reject);
          req2.end();
        } else {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Try each selector in order, return the first VISIBLE element handle found (or null).
// Retries once on "Execution context was destroyed" errors, which happen if a
// navigation is still settling when this runs.
async function firstMatch(page, selectors, _retried) {
  try {
    for (const sel of selectors) {
      const els = await page.$$(sel);
      for (const el of els) {
        const visible = await el.evaluate(e => {
          const r = e.getBoundingClientRect();
          const style = window.getComputedStyle(e);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        }).catch(() => false);
        if (visible) return { el, sel };
      }
    }
    return null;
  } catch (e) {
    if (!_retried && /execution context was destroyed|context.*destroyed/i.test(e.message)) {
      console.log('  Page context changed mid-search (likely a navigation) — waiting and retrying once...');
      await new Promise(r => setTimeout(r, 2000));
      return firstMatch(page, selectors, true);
    }
    throw e;
  }
}

// Click an element robustly: try a real Puppeteer click (which does hit-testing
// and can fail if something overlaps the element), then fall back to a
// JS-dispatched click if that fails.
async function safeClick(page, el, label) {
  try {
    await el.evaluate(e => e.scrollIntoView({ block: 'center' }));
    await new Promise(r => setTimeout(r, 200));
    await el.click();
    return true;
  } catch (e) {
    console.log(`  Native click failed for ${label} (${e.message}) — trying JS click fallback`);
    try {
      await el.evaluate(e => e.click());
      return true;
    } catch (e2) {
      console.log(`  JS click fallback also failed for ${label}: ${e2.message}`);
      return false;
    }
  }
}

async function dismissCookieBanner(page) {
  const candidates = [
    'button#onetrust-accept-btn-handler',
    'button[aria-label="Accept all cookies"]',
    'button[aria-label="Accept All"]',
    '[data-test-selector="cookie-accept"]',
    '#usercentrics-root'
  ];
  let found = await firstMatch(page, candidates);

  // Fallback: search all buttons for "Accept" text (covers OneTrust, Usercentrics,
  // Cookiebot, and most custom banners without needing their exact selector).
  if (!found) {
    const handle = await page.evaluateHandle(() => {
      const els = Array.from(document.querySelectorAll('button, a'));
      return els.find(e => /^(accept all|accept cookies|accept|i agree|allow all)$/i.test((e.textContent || '').trim())) || null;
    });
    const el = handle.asElement();
    if (el) found = { el, sel: '(text match: Accept)' };
  }

  if (found) {
    console.log(`  Dismissing cookie banner via ${found.sel}`);
    await safeClick(page, found.el, 'cookie banner');
    // Consent platforms often trigger a full page reload after accept — wait
    // for that navigation if it happens, otherwise just settle briefly.
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }),
      new Promise(r => setTimeout(r, 3000))
    ]).catch(() => {});
  } else {
    console.log('  No cookie banner matched known selectors (may not be present, or may need a new selector)');
  }
}

async function login(page) {
  console.log('Loading racingpost.com...');
  await page.goto('https://www.racingpost.com/', { waitUntil: 'networkidle2', timeout: 60000 });
  await dismissCookieBanner(page);

  console.log('Looking for a login link/button...');
  const loginLinkSelectors = [
    'a[href*="login"]',
    'a[data-test-selector*="login"]',
    'button[data-test-selector*="login"]',
    '[data-test-selector="ptp-headerLoginButton"]'
  ];
  let loginTrigger = await firstMatch(page, loginLinkSelectors);

  // Fallback: search all clickable elements for "Log in" text
  if (!loginTrigger) {
    console.log('  No selector match — searching page text for a "Log in" control...');
    const handle = await page.evaluateHandle(() => {
      const els = Array.from(document.querySelectorAll('a, button'));
      return els.find(e => /log\s*in/i.test(e.textContent || '')) || null;
    });
    const el = handle.asElement();
    if (el) loginTrigger = { el, sel: '(text match: Log in)' };
  }

  if (!loginTrigger) {
    console.error('  Could not find any login trigger. Saving debug artifacts.');
    await saveDebugArtifact(page, 'no-login-trigger');
    throw new Error('Login trigger not found');
  }

  console.log(`  Clicking login trigger (${loginTrigger.sel})`);
  const clicked = await safeClick(page, loginTrigger.el, 'login trigger');
  if (!clicked) {
    await saveDebugArtifact(page, 'login-trigger-unclickable');
    throw new Error('Login trigger found but could not be clicked');
  }
  await new Promise(r => setTimeout(r, 2000));

  // Login form may be a modal or a full page nav — check both.
  const emailSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input#email',
    'input[autocomplete="username"]'
  ];
  const passwordSelectors = [
    'input[type="password"]',
    'input[name="password"]',
    'input#password',
    'input[autocomplete="current-password"]'
  ];

  await page.waitForSelector(emailSelectors.join(','), { timeout: 15000 }).catch(() => {});

  const emailField = await firstMatch(page, emailSelectors);
  const passwordField = await firstMatch(page, passwordSelectors);

  if (!emailField || !passwordField) {
    console.error('  Could not find email/password fields. Saving debug artifacts.');
    await saveDebugArtifact(page, 'no-login-fields');
    throw new Error('Login form fields not found');
  }

  console.log(`  Filling email (${emailField.sel}) and password (${passwordField.sel})`);
  await emailField.el.type(RP_EMAIL, { delay: 30 });
  await passwordField.el.type(RP_PASSWORD, { delay: 30 });

  const submitSelectors = [
    'button[type="submit"]',
    'button[data-test-selector*="submit"]',
    'button[data-test-selector*="login"]'
  ];
  let submitBtn = await firstMatch(page, submitSelectors);
  if (!submitBtn) {
    // Fallback: press Enter in the password field
    console.log('  No submit button matched — pressing Enter instead');
    await passwordField.el.press('Enter');
  } else {
    console.log(`  Clicking submit (${submitBtn.sel})`);
    await safeClick(page, submitBtn.el, 'submit button');
  }

  await new Promise(r => setTimeout(r, 3000));
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {
    console.log('  No navigation detected after submit (may be a modal-based login — continuing)');
  });

  // Verify login succeeded: look for an account/logout indicator, absence of "Log in"
  const loggedIn = await page.evaluate(() => {
    const bodyText = document.body.innerText || '';
    const hasLogout = /log\s*out|my\s*account/i.test(bodyText);
    const hasLoginPrompt = /\blog\s*in\b/i.test(bodyText.slice(0, 3000)); // header area roughly
    return hasLogout || !hasLoginPrompt;
  });

  if (!loggedIn) {
    console.error('  Login verification failed — page still looks logged out. Saving debug artifacts.');
    await saveDebugArtifact(page, 'login-verify-failed');
    throw new Error('Login could not be verified');
  }

  console.log('  Login verified.');
}

// Discover today's race URLs from the racecards index.
async function discoverRaceUrls(page) {
  console.log('Loading racecards index...');
  await page.goto('https://www.racingpost.com/racecards', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 1500));

  const urls = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/racecards/"]'));
    const hrefs = anchors
      .map(a => a.getAttribute('href'))
      .filter(h => h && /\/racecards\/\d+\/[^/]+\/\d{4}-\d{2}-\d{2}\/\d+/.test(h));
    return Array.from(new Set(hrefs));
  });

  const fullUrls = urls.map(u => u.startsWith('http') ? u : `https://www.racingpost.com${u}`);
  console.log(`  Found ${fullUrls.length} race URLs`);
  return fullUrls;
}

// Extract meeting/time/runners/tips from a single race page.
// Best-effort: tries data-test-selector patterns first, falls back to
// label-text matching within each runner row for RPR/TS/OR/RTF values.
async function extractRace(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise(r => setTimeout(r, 1000));

  const data = await page.evaluate(() => {
    function textOf(el) { return (el && el.textContent || '').trim(); }

    // Meeting name + time: try a header region, fall back to <title> or URL parts.
    const headerCourse = document.querySelector('[data-test-selector*="courseName"], h1');
    const meeting = textOf(headerCourse) || document.title.split('|')[0].trim();

    const timeEl = document.querySelector('[data-test-selector*="raceTime"], time');
    const time = textOf(timeEl);

    // Runner rows: try common RP data-test-selector patterns first.
    let rowEls = Array.from(document.querySelectorAll('[data-test-selector*="runner-row"], [data-test-selector*="RC-runnerRow"]'));
    if (rowEls.length === 0) {
      // Fallback: any element that contains both a horse-name-like link and looks repeated
      rowEls = Array.from(document.querySelectorAll('tr')).filter(tr => tr.querySelectorAll('td').length >= 4);
    }

    function findValueNear(row, label) {
      // Look for a cell/label containing the given text, return the next sibling's text.
      const cells = Array.from(row.querySelectorAll('td, div, span'));
      const labelEl = cells.find(c => new RegExp('^' + label + '$', 'i').test((c.textContent || '').trim()));
      if (labelEl && labelEl.nextElementSibling) return textOf(labelEl.nextElementSibling);
      return '';
    }

    const runners = rowEls.map(row => {
      const nameEl = row.querySelector('a[href*="/profile/horse/"], a[data-test-selector*="horseName"]');
      const name = textOf(nameEl);
      if (!name) return null;

      const horseIdMatch = (nameEl && nameEl.getAttribute('href') || '').match(/\/horse\/(\d+)/);
      const jockeyEl = row.querySelector('a[href*="/profile/jockey/"]');
      const trainerEl = row.querySelector('a[href*="/profile/trainer/"]');

      return {
        name,
        horseId: horseIdMatch ? horseIdMatch[1] : null,
        jockey: textOf(jockeyEl),
        trainer: textOf(trainerEl),
        rpr: findValueNear(row, 'RPR'),
        ts: findValueNear(row, 'TS'),
        or: findValueNear(row, 'OR'),
        trainerRtf: findValueNear(row, 'RTF'),
        forecastOdds: textOf(row.querySelector('[data-test-selector*="forecastPrice"], [data-test-selector*="odds"]')),
        headgear: textOf(row.querySelector('[data-test-selector*="headgear"]')),
        nonRunner: /non.?runner/i.test(row.textContent || '')
      };
    }).filter(Boolean);

    // Tips: best-effort — look for a tips widget block if present.
    const tipEls = Array.from(document.querySelectorAll('[data-test-selector*="tip"]'));
    const tips = tipEls.map(t => {
      const horseEl = t.querySelector('a[href*="/profile/horse/"]');
      return horseEl ? { horse: textOf(horseEl), sources: [textOf(t)].filter(Boolean) } : null;
    }).filter(Boolean);

    return { meeting, time, runners, tips, runnerRowCount: rowEls.length };
  });

  return data;
}

(async () => {
  console.log('Starting racingpost.com scrape...');
  console.log('Time:', new Date().toISOString());

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');
  await page.setViewport({ width: 1400, height: 1000 });

  let races = [];
  try {
    await login(page);

    const raceUrls = await discoverRaceUrls(page);
    if (raceUrls.length === 0) {
      console.error('No race URLs discovered. Saving debug artifacts.');
      await saveDebugArtifact(page, 'no-race-urls');
      await browser.close();
      process.exit(1);
    }

    for (let i = 0; i < raceUrls.length; i++) {
      const url = raceUrls[i];
      console.log(`Extracting race ${i + 1}/${raceUrls.length}: ${url}`);
      try {
        const raceData = await extractRace(page, url);
        console.log(`  meeting="${raceData.meeting}" time="${raceData.time}" runners=${raceData.runners.length} (rows seen: ${raceData.runnerRowCount}) tips=${raceData.tips.length}`);
        if (raceData.runners.length === 0 && i === 0) {
          // First race came back empty — save debug artifacts once so we can diagnose.
          await saveDebugArtifact(page, 'first-race-empty');
        }
        races.push({
          meeting: raceData.meeting,
          time: raceData.time,
          runners: raceData.runners,
          tips: raceData.tips
        });
      } catch (e) {
        console.error(`  Failed to extract ${url}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 800)); // be polite between requests
    }
  } catch (e) {
    console.error('Fatal error during scrape:', e.message);
    await browser.close();
    process.exit(1);
  }

  await browser.close();

  const totalRunners = races.reduce((sum, r) => sum + r.runners.length, 0);
  console.log(`\nTotal races scraped: ${races.length}, total runners: ${totalRunners}`);

  // Safety guard: never send an empty/near-empty payload — could wipe good sheet data.
  if (totalRunners === 0) {
    console.error('ABORTING: zero runners extracted across all races. This usually means');
    console.error('RP changed their page structure or login/session failed silently.');
    console.error('Sheets were NOT touched — existing data is safe.');
    process.exit(1);
  }

  const payload = {
    action: 'saverpdata',
    extractedDate: todayISODate(),
    races
  };

  console.log('\nSending to Apps Script...');
  let allOk = true;
  for (const target of TARGET_URLS) {
    try {
      const result = await sendJSON(target.url, payload);
      const parsed = JSON.parse(result.body);
      if (parsed.success) {
        console.log(`  - ${target.name}: saved OK (${JSON.stringify(parsed.rows || parsed)})`);
      } else {
        console.error(`  X ${target.name}: ${parsed.error || 'unknown error'}`);
        allOk = false;
      }
    } catch (e) {
      console.error(`  X ${target.name} failed: ${e.message}`);
      allOk = false;
    }
  }

  if (!allOk) {
    console.error('\nOne or more targets failed to save.');
    process.exit(1);
  }

  console.log('\nDone!');
})();
