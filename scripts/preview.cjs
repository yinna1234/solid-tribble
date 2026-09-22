/* 本地预览 dashboard 并截图 */
const { chromium } = require('playwright-core');
const CHROME = 'C:\\Users\\Y\\.agent-browser\\browsers\\chrome-153.0.8010.52\\chrome.exe';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('console', (m) => console.log('[console]', m.type(), m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('http://127.0.0.1:8021/index.html', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'C:\\Users\\Y\\WorkBuddy\\2026-09-18-09-25-19\\bi-dashboard\\recon\\dashboard.png', fullPage: true });
  console.log('SHOT DONE');
  await browser.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
