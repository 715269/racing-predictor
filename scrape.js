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

// Extract a table by matching the heading text immediately preceding it
async function extractTableByHeading(page, headingText) {
  return await page.evaluate((headingText) => {
    const headings = Array.from(document.querySelectorAll('h2, h3'));
    const heading = headings.find(h => h.textContent.trim() === headingText);
    if (!heading) return [];

    // Walk forward from the heading to find the next table
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
    if (!table) return [];

    const rows = Array.from(table.querySelectorAll('tbody tr, tr'));
    const data = [];
    rows.forEach(row => {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length === 0) return; // header row uses <th>, skip

      // First cell often contains name + nested "Wins: X Runs: Y" text plus a link
      const rowData = cells.map(c => c.innerText.trim());
      data.push(rowData);
    });
    return data;
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
      headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location);
          const req2 = https.request({
            hostname: redirectUrl.hostname,
            path: redirectUrl.pathname + redirectUrl.search,
            method: 'POST',
            headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) }
          }, (res2) => {
            let data2 = '';
            res2.on('data', chunk => data2 += chunk);
            res2.on('end', () => resolve({ status: res2.statusCode, body: data2 }));
          });
          req2.on('error', reject);
          req2.write(body);
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

  await new Promise(r => setTimeout(r, 2000));

  // ── HOT TRAINERS ──────────────────────────────────────────────────
  console.log('Extracting Hot Trainers...');
  const trainerRows = await extractTableByHeading(page, 'Hot Trainers');
  const hotTrainers = trainerRows.map(r => {
    // r[0] is name (may include nested Wins/Runs text — take first line only)
    const name = (r[0] || '').split('\n')[0].trim();
    return { name, wins: r[1], runs: r[2], pct: parsePct(r[3]) };
  }).filter(r => r.name);
  console.log(`  Found ${hotTrainers.length} trainers`);

  // ── HOT JOCKEYS ───────────────────────────────────────────────────
  console.log('Extracting Hot Jockeys...');
  const jockeyRows = await extractTableByHeading(page, 'Hot Jockeys');
  const hotJockeys = jockeyRows.map(r => {
    const name = (r[0] || '').split('\n')[0].trim();
    return { name, wins: r[1], runs: r[2], pct: parsePct(r[3]) };
  }).filter(r => r.name);
  console.log(`  Found ${hotJockeys.length} jockeys`);

  // ── TOP COURSE TRAINERS ───────────────────────────────────────────
  console.log('Extracting Top Course Trainers...');
  const courseTrainerRows = await extractTableByHeading(page, 'Top Course Trainers');
  const courseTrainers = courseTrainerRows.map(r => {
    const name = (r[0] || '').split('\n')[0].trim();
    const course = (r[1] || '').split('\n')[0].trim();
    return { name, course, wins: r[2], runs: r[3], pct: parsePct(r[4]) };
  }).filter(r => r.name && r.course);
  console.log(`  Found ${courseTrainers.length} course trainer rows`);

  // ── LONGEST TRAVELLERS (used in place of C&D Winners — see note) ──
  console.log('Extracting Longest Travellers...');
  const travellerRows = await extractTableByHeading(page, 'Longest Travellers');
  const cdWinners = travellerRows.map(r => {
    const horse = (r[0] || '').split('\n')[0].trim();
    const trainer = (r[1] || '').split('\n')[0].trim();
    const race = (r[2] || '').split('\n')[0].trim();
    const odds = r[4] || '';
    return { horse, trainer, race, odds };
  }).filter(r => r.horse && r.trainer);
  console.log(`  Found ${cdWinners.length} traveller rows`);

  await browser.close();

  // ── SEND TO APPS SCRIPT (4 separate requests) ─────────────────────
  console.log('\nSending data to Google Sheet...');
  const tables = [
    { name: 'hotTrainers',    payload: { action: 'saveformdata', hotTrainers } },
    { name: 'hotJockeys',     payload: { action: 'saveformdata', hotJockeys } },
    { name: 'courseTrainers', payload: { action: 'saveformdata', courseTrainers } },
    { name: 'cdWinners',      payload: { action: 'saveformdata', cdWinners } }
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
  console.log(`  Longest Travellers: ${cdWinners.length} rows`);

  if (!allOk) {
    console.error('\nOne or more tables failed to save.');
    process.exit(1);
  }

  console.log('\nDone!');
})();
