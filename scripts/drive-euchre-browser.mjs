// Headless-browser driver that starts a Euchre quick game (1 human + 3 bots),
// plays the human seat (pass on bids, name trump if forced, handle the call,
// click legal cards), and stops once the trick-history panel renders. It
// prints the panel's grid DOM and saves a full-page screenshot.
//
// Requires: the client running on $CLIENT_URL (default http://localhost:5173),
// the server on port 8000, a running bot, and Playwright's Chromium with its
// system deps (see scripts/README.md).
//
// Usage:
//   node scripts/drive-euchre-browser.mjs
//   CLIENT_URL=http://localhost:5173 SHOT=/tmp/board.png node scripts/drive-euchre-browser.mjs
//
// Env:
//   CLIENT_URL  client base URL (default http://localhost:5173)
//   SHOT        screenshot output path (default scripts/euchre-board.png)
import { chromium } from 'playwright';

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
const SHOT = process.env.SHOT || new URL('euchre-board.png', import.meta.url).pathname;

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
page.setDefaultTimeout(15000);
await page.goto(CLIENT_URL, { waitUntil: 'load', timeout: 30000 });
await page.waitForTimeout(1500);

// Open Quick Game, pick Euchre, start.
await page.getByText('Quick Game', { exact: false }).first().click();
await page.waitForTimeout(800);
await page.evaluate(() => {
  const startBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Start Match');
  let container = startBtn.parentElement;
  for (let i = 0; i < 6 && container; i++) { if (container.querySelectorAll('select').length >= 1) break; container = container.parentElement; }
  const gameSel = Array.from(container.querySelectorAll('select')).find((s) => Array.from(s.options).some((o) => o.value === 'euchre'));
  gameSel.value = 'euchre';
  gameSel.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(500);
await page.getByText('Start Match', { exact: true }).first().click();
await page.waitForTimeout(1500);

const deadline = Date.now() + 200000;
let lastAction = '(none)';

const readState = () => page.evaluate(() => {
  const txt = document.body.innerText;
  const buttons = Array.from(document.querySelectorAll('button')).map((b) => b.textContent.trim());
  const legalCards = Array.from(document.querySelectorAll('div')).filter((d) => {
    const cs = getComputedStyle(d);
    return cs.borderTopColor === 'rgb(124, 252, 0)' && cs.width === '46px';
  });
  const grids = Array.from(document.querySelectorAll('div')).filter((d) => {
    const cs = getComputedStyle(d);
    return cs.display === 'grid' && cs.gridTemplateColumns.split(' ').length >= 4;
  });
  return { txt, buttons, legalCount: legalCards.length, gridFound: grids.length > 0 };
});

while (Date.now() < deadline) {
  const s = await readState();
  const txt = s.txt;
  const has = (re) => re.test(txt);
  const myBid = has(/Your turn to bid/);
  const myTrump = has(/Name your trump suit/);
  const myCall = has(/You are the declarer|Choose a card to discard/);
  const myPlay = has(/Your turn to lead|Your turn to play/);

  if (s.gridFound) {
    lastAction = 'TRICK PANEL VISIBLE';
    const panel = await page.evaluate(() => {
      const g = Array.from(document.querySelectorAll('div')).find((d) => {
        const cs = getComputedStyle(d);
        return cs.display === 'grid' && cs.gridTemplateColumns.split(' ').length >= 4;
      });
      if (!g) return { found: false };
      const cells = Array.from(g.children).map((c) => c.innerText.replace(/\s+/g, ' ').trim());
      return { found: true, cols: getComputedStyle(g).gridTemplateColumns, cellCount: cells.length, cells };
    });
    console.log('PANEL:', JSON.stringify(panel));
    break;
  }

  let acted = false;
  if (myBid) {
    await page.getByText('Pass', { exact: true }).first().click().catch(() => {});
    acted = true; lastAction = 'pass bid';
  } else if (myTrump) {
    await page.getByText('Spades', { exact: true }).first().click().catch(() => {});
    acted = true; lastAction = 'name trump Spades';
  } else if (myCall) {
    for (const label of ['Continue', 'Go with Partner', 'Go Alone']) {
      const btn = page.getByText(label, { exact: true }).first();
      if (await btn.count()) { await btn.click().catch(() => {}); acted = true; lastAction = 'call: ' + label; break; }
    }
  } else if (myPlay) {
    if (s.legalCount > 0) {
      await page.evaluate(() => {
        const card = Array.from(document.querySelectorAll('div')).find((d) => {
          const cs = getComputedStyle(d);
          return cs.borderTopColor === 'rgb(124, 252, 0)' && cs.width === '46px';
        });
        if (card) card.click();
      });
      acted = true; lastAction = 'play card';
    }
  }
  if (acted) await page.waitForTimeout(2500);
  else await page.waitForTimeout(2000);
}

await page.screenshot({ path: SHOT, fullPage: true });
console.log('LAST ACTION:', lastAction);
console.log('SCREENSHOT:', SHOT);
await browser.close();
