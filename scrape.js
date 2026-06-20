// scrape.js — scrapes horseracing.net/stats and POSTs data to Apps Script
// Runs via Puppeteer in GitHub Actions

const puppeteer = require('puppeteer');

const SCRIPT_URL = process.env.APPS_SCRIPT_URL;

if (!SCRIPT_URL) {
  console.error('ERROR: APPS_SCRIPT_URL environment variable not set');
  process.exit(1);
}

function parsePct(val) {
  const cleaned = parseFloat(String(val || '').replace('%', '')) || 0;
  return cleaned > 1 ? cleaned / 100 : cleaned;
}

// Extract a table by matching the heading text immediately preceding it.
// Returns { headers: [...], rows: [[...], ...] }
async function extractTableByHeading(page, headingText) {
  return await page.evaluate((headingText) => {
    const headings = Array.from(document.querySelectorAll('h2, h3'));
    const heading = headings.find(h => h.textContent.trim() === headingText);
    if (!heading) return { headers: [], rows: [] };

    let el = heading.nextElementSibling;
    let table = null;
    let attempts = 0;
    while (el && attempts < 10) {
      if (el.tagName === 'TABLE') { table = el; break; }
      const found = el.querySelector && el.querySelector('table');
      if (found) { table = found; break; }
      el = el.nextElementSibling;
      attempts++;
    }
    if (!table) return { headers: [], rows: [] };

    const headerCells = Array.from(table.querySelectorAll('thead th, tr th'));
    const headers = headerCells.map(c => c.innerText.trim());

    const rows = Array.from(table.querySelectorAll('tbody tr, tr'));
    const data = [];
    rows.forEach(row => {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length === 0) return;
      data.push(cells.map(c => c.innerText.trim()));
    });
    return { headers, rows: data };
  }, headingText);
}

async function sendTable(name, payload) {
  const https = require('https');
  const url = new URL(SCRIPT_URL);
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
          // Apps Script redirects to the computed result — fetch it with GET, not POST
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

(async () => {
  console.log('Starting horseracing.net/stats scrape...');
  console.log('Time:', new Date().toISOString());

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');

  console.log('Loading horseracing.net/stats ...');
  await page.goto('https://www.horseracing.net/stats', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  // Cloudflare-style "Just a moment..." challenge can appear before the real
  // page loads. Wait for the real heading to appear, polling for up to 20s.
  console.log('Waiting for real page content (past any security check)...');
  try {
    await page.waitForFunction(
      () => document.title !== 'Just a moment...' && document.querySelectorAll('table').length > 0,
      { timeout: 20000 }
    );
    console.log('Real content detected.');
  } catch (e) {
    console.log('WARNING: still no tables after 20s wait — may be blocked by bot detection.');
  }

  await new Promise(r => setTimeout(r, 1500));

  // ── DEBUG: dump page info so we can see what Puppeteer actually got ──
  const debugInfo = await page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll('h1,h2,h3')).map(h => h.tagName + ': ' + h.textContent.trim());
    const tableCount = document.querySelectorAll('table').length;
    const bodyLength = document.body.innerText.length;
    const title = document.title;
    const hasConsentBanner = document.body.innerText.toLowerCase().includes('cookies') && document.body.innerText.toLowerCase().includes('accept');
    return { headings: headings.slice(0, 20), tableCount, bodyLength, title, hasConsentBanner };
  });
  console.log('--- DEBUG INFO ---');
  console.log('Page title:', debugInfo.title);
  console.log('Body text length:', debugInfo.bodyLength);
  console.log('Table count on page:', debugInfo.tableCount);
  console.log('Possible cookie banner blocking content:', debugInfo.hasConsentBanner);
  console.log('Headings found (first 20):');
  debugInfo.headings.forEach(h => console.log('  ' + h));
  console.log('--- END DEBUG ---\n');

  // Save a screenshot for diagnosis — uploaded as a GitHub Actions artifact
  try {
    await page.screenshot({ path: 'debug-screenshot.png', fullPage: true });
    console.log('Saved debug-screenshot.png');
  } catch (e) {
    console.log('Could not save screenshot:', e.message);
  }

  // ── HOT TRAINERS ──────────────────────────────────────────────────
  console.log('Extracting Hot Trainers...');
  const trainerTable = await extractTableByHeading(page, 'Hot Trainers');
  console.log(`  Headers: [${trainerTable.headers.join(', ')}]`);
  const hotTrainers = trainerTable.rows.map(r => {
    const name = (r[0] || '').split('\n')[0].trim();
    return { name, wins: r[1], runs: r[2], pct: parsePct(r[3]) };
  }).filter(r => r.name);
  console.log(`  Found ${hotTrainers.length} trainers`);

  // ── HOT JOCKEYS ───────────────────────────────────────────────────
  console.log('Extracting Hot Jockeys...');
  const jockeyTable = await extractTableByHeading(page, 'Hot Jockeys');
  console.log(`  Headers: [${jockeyTable.headers.join(', ')}]`);
  const hotJockeys = jockeyTable.rows.map(r => {
    const name = (r[0] || '').split('\n')[0].trim();
    return { name, wins: r[1], runs: r[2], pct: parsePct(r[3]) };
  }).filter(r => r.name);
  console.log(`  Found ${hotJockeys.length} jockeys`);

  // ── TOP COURSE TRAINERS ───────────────────────────────────────────
  console.log('Extracting Top Course Trainers...');
  const courseTrainerTable = await extractTableByHeading(page, 'Top Course Trainers');
  console.log(`  Headers: [${courseTrainerTable.headers.join(', ')}]`);
  const courseTrainers = courseTrainerTable.rows.map(r => {
    const name = (r[0] || '').split('\n')[0].trim();
    const course = (r[1] || '').split('\n')[0].trim();
    return { name, course, wins: r[2], runs: r[3], pct: parsePct(r[4]) };
  }).filter(r => r.name && r.course);
  console.log(`  Found ${courseTrainers.length} course trainer rows`);

  // ── COURSE & DISTANCE WINNERS ──────────────────────────────────────
  console.log('Extracting Course & Distance Winners...');
  const cdTable = await extractTableByHeading(page, 'Course & Distance Winners');
  console.log(`  Headers: [${cdTable.headers.join(', ')}]`);
  // Column order isn't confirmed yet, so log a sample row to verify mapping
  if (cdTable.rows.length > 0) {
    console.log('  Sample row:', JSON.stringify(cdTable.rows[0]));
  }
  // Map by position, assuming: [runner/horse, trainer, race, ...maybe odds]
  // The last cell is taken as odds if it looks like odds (contains '/')
  const cdWinners = cdTable.rows.map(r => {
    const horse = (r[0] || '').split('\n')[0].trim();
    const trainer = (r[1] || '').split('\n')[0].trim();
    const race = (r[2] || '').split('\n')[0].trim();
    const lastCell = (r[r.length - 1] || '').trim();
    const odds = /\d+\/\d+/.test(lastCell) ? lastCell : '';
    return { horse, trainer, race, odds };
  }).filter(r => r.horse && r.trainer);
  console.log(`  Found ${cdWinners.length} C&D winner rows`);

  // Fallback: if Course & Distance Winners heading wasn't found on the page,
  // use Longest Travellers instead so the sheet still gets useful data
  let finalCdWinners = cdWinners;
  if (cdTable.rows.length === 0) {
    console.log('  Course & Distance Winners table not found — falling back to Longest Travellers');
    const travellerTable = await extractTableByHeading(page, 'Longest Travellers');
    finalCdWinners = travellerTable.rows.map(r => {
      const horse = (r[0] || '').split('\n')[0].trim();
      const trainer = (r[1] || '').split('\n')[0].trim();
      const race = (r[2] || '').split('\n')[0].trim();
      const odds = r[4] || '';
      return { horse, trainer, race, odds };
    }).filter(r => r.horse && r.trainer);
    console.log(`  Found ${finalCdWinners.length} traveller rows (fallback)`);
  }

  await browser.close();

  // ── SAFETY GUARD: never overwrite good sheet data with an empty scrape ──
  const totalRows = hotTrainers.length + hotJockeys.length + courseTrainers.length + finalCdWinners.length;
  if (totalRows === 0) {
    console.error('\nABORTING: all tables came back empty. This usually means the');
    console.error('site blocked the scraper (bot detection) or changed its layout.');
    console.error('Sheets were NOT touched — existing data is safe.');
    process.exit(1);
  }

  // ── SEND TO APPS SCRIPT (4 separate requests) ─────────────────────
  console.log('\nSending data to Google Sheet...');
  const tables = [
    { name: 'hotTrainers',    payload: { action: 'saveformdata', hotTrainers } },
    { name: 'hotJockeys',     payload: { action: 'saveformdata', hotJockeys } },
    { name: 'courseTrainers', payload: { action: 'saveformdata', courseTrainers } },
    { name: 'cdWinners',      payload: { action: 'saveformdata', cdWinners: finalCdWinners } }
  ];

  let allOk = true;
  for (const t of tables) {
    try {
      const result = await sendTable(t.name, t.payload);
      const parsed = JSON.parse(result.body);
      if (parsed.success) {
        console.log(`  - ${t.name}: saved OK`);
      } else {
        console.error(`  X ${t.name}: ${parsed.error || 'unknown error'}`);
        allOk = false;
      }
    } catch (e) {
      console.error(`  X ${t.name} failed: ${e.message}`);
      allOk = false;
    }
  }

  console.log('\nSummary:');
  console.log(`  Hot Trainers:    ${hotTrainers.length} rows`);
  console.log(`  Hot Jockeys:     ${hotJockeys.length} rows`);
  console.log(`  Course Trainers: ${courseTrainers.length} rows`);
  console.log(`  C&D Winners:     ${finalCdWinners.length} rows`);

  if (!allOk) {
    console.error('\nOne or more tables failed to save.');
    process.exit(1);
  }

  console.log('\nDone!');
})();
