// scrape.js — scrapes horseracing.net/form and POSTs data to Apps Script
// Runs via Puppeteer in GitHub Actions (headless Chrome)

const puppeteer = require('puppeteer');

const SCRIPT_URL = process.env.APPS_SCRIPT_URL;

if (!SCRIPT_URL) {
  console.error('ERROR: APPS_SCRIPT_URL environment variable not set');
  process.exit(1);
}

function parsePct(val) {
  // Handle both "23%" and "0.23" from the site
  const cleaned = parseFloat(String(val || '').replace('%', '')) || 0;
  return cleaned > 1 ? cleaned / 100 : cleaned;
}

async function expandSection(page, headingText) {
  // Find the section heading and click it if it's collapsed
  await page.evaluate((text) => {
    const headings = Array.from(document.querySelectorAll('h2, h3, .section-title, [class*="heading"], [class*="title"]'));
    const match = headings.find(h => h.textContent.trim().includes(text));
    if (match) {
      // Click the heading or its parent if it's a toggle
      const toggle = match.closest('[class*="accordion"], [class*="collapse"], [class*="expand"]') || match;
      toggle.click();
    }
  }, headingText);
  await new Promise(r => setTimeout(r, 1500)); // wait for animation
}

async function extractTable(page, sectionText) {
  return await page.evaluate((sectionText) => {
    // Find the section containing this heading
    const allText = document.body.innerText;
    
    // Find all tables on the page
    const tables = Array.from(document.querySelectorAll('table'));
    
    // Find the one nearest to the heading text
    let targetTable = null;
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,th,[class*="title"],[class*="heading"]'));
    
    for (const h of headings) {
      if (h.textContent.includes(sectionText)) {
        // Look for a table following this heading
        let el = h;
        while (el && el.tagName !== 'TABLE') {
          if (el.nextElementSibling) {
            el = el.nextElementSibling;
            const tbl = el.tagName === 'TABLE' ? el : el.querySelector('table');
            if (tbl) { targetTable = tbl; break; }
          } else {
            el = el.parentElement;
          }
        }
        if (targetTable) break;
      }
    }
    
    if (!targetTable) return [];
    
    const rows = Array.from(targetTable.querySelectorAll('tr'));
    const result = [];
    
    rows.forEach((row, i) => {
      if (i === 0) return; // skip header
      const cells = Array.from(row.querySelectorAll('td,th')).map(c => c.textContent.trim());
      if (cells.length >= 2 && cells[0]) result.push(cells);
    });
    
    return result;
  }, sectionText);
}

async function sendTable(name, payload) {
  const https = require('https');
  const http = require('http');
  const url = new URL(SCRIPT_URL);
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Follow redirects (Apps Script uses 302)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          console.log(`  Following redirect for ${name}...`);
          const redirectUrl = new URL(res.headers.location);
          const req2 = https.request({
            hostname: redirectUrl.hostname,
            path: redirectUrl.pathname + redirectUrl.search,
            method: 'POST',
            headers: {
              'Content-Type': 'text/plain',
              'Content-Length': Buffer.byteLength(body)
            }
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
  console.log('Starting horseracing.net scrape...');
  console.log('Time:', new Date().toISOString());

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');

  console.log('Loading horseracing.net/form ...');
  await page.goto('https://www.horseracing.net/form', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  // Give JS tables time to render
  await new Promise(r => setTimeout(r, 3000));

  // Expand all collapsible sections
  console.log('Expanding sections...');
  const sections = ['Hot Trainers', 'Hot Jockeys', 'Top Course Trainers', 'Course & Distance Winners'];
  for (const s of sections) {
    await expandSection(page, s);
  }

  // ── HOT TRAINERS ──────────────────────────────────────────────────
  console.log('Extracting Hot Trainers...');
  const trainerRows = await extractTable(page, 'Hot Trainers');
  const hotTrainers = trainerRows.map(r => ({
    name: r[0],
    wins: r[1],
    runs: r[2],
    pct:  parsePct(r[3])
  })).filter(r => r.name && r.name !== 'TRAINER');
  console.log(`  Found ${hotTrainers.length} trainers`);

  // ── HOT JOCKEYS ───────────────────────────────────────────────────
  console.log('Extracting Hot Jockeys...');
  const jockeyRows = await extractTable(page, 'Hot Jockeys');
  const hotJockeys = jockeyRows.map(r => ({
    name: r[0],
    wins: r[1],
    runs: r[2],
    pct:  parsePct(r[3])
  })).filter(r => r.name && r.name !== 'JOCKEY');
  console.log(`  Found ${hotJockeys.length} jockeys`);

  // ── COURSE TRAINERS ───────────────────────────────────────────────
  console.log('Extracting Course Trainers...');
  const courseTrainerRows = await extractTable(page, 'Top Course Trainers');
  const courseTrainers = courseTrainerRows.map(r => ({
    name:   r[0],
    course: r[1],
    wins:   r[2],
    runs:   r[3],
    pct:    parsePct(r[4])
  })).filter(r => r.name && r.course);
  console.log(`  Found ${courseTrainers.length} course trainer rows`);

  // ── C&D WINNERS ───────────────────────────────────────────────────
  console.log('Extracting C&D Winners...');
  const cdRows = await extractTable(page, 'Course & Distance Winners');
  const cdWinners = cdRows.map(r => ({
    horse:   r[0],
    trainer: r[1],
    race:    r[2],
    odds:    r[3] || ''
  })).filter(r => r.horse && r.trainer);
  console.log(`  Found ${cdWinners.length} C&D winners`);

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
        console.log(`  ✓ ${t.name}: saved OK`);
      } else {
        console.error(`  ✗ ${t.name}: ${parsed.error || 'unknown error'}`);
        allOk = false;
      }
    } catch (e) {
      console.error(`  ✗ ${t.name} failed: ${e.message}`);
      allOk = false;
    }
  }

  console.log('\nSummary:');
  console.log(`  Hot Trainers:    ${hotTrainers.length} rows`);
  console.log(`  Hot Jockeys:     ${hotJockeys.length} rows`);
  console.log(`  Course Trainers: ${courseTrainers.length} rows`);
  console.log(`  C&D Winners:     ${cdWinners.length} rows`);

  if (!allOk) {
    console.error('\nOne or more tables failed to save.');
    process.exit(1);
  }

  console.log('\nDone!');
})();
