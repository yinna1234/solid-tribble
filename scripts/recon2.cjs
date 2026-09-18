/* 第二轮探测:登录后 dump 三张表的 DOM 结构,确定提取选择器 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:\\Users\\Y\\.agent-browser\\browsers\\chrome-153.0.8010.52\\chrome.exe';
const VIEWER_URL =
  'https://bi.hmccloud.com/bi/viewer?proc=1&action=viewer&hback=true&db=__MY_DB__!2f!2026!5468!!5e74!!5e86!!2f!!6570!!636e!!96c6!!8868!!683c!.db';
const OUT = path.join(__dirname, '..', 'recon');

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();

  await page.goto(VIEWER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  const inputs = await page.$$('input');
  let userInput = null;
  let passInput = null;
  for (const i of inputs) {
    const t = (await i.getAttribute('type')) || '';
    if (t === 'password') passInput = i;
    else if (!userInput && t !== 'hidden' && t !== 'checkbox' && t !== 'radio') userInput = i;
  }
  await userInput.fill(process.env.BI_USER);
  await passInput.fill(process.env.BI_PASS);
  await passInput.press('Enter');
  await page.waitForTimeout(15000);

  const info = await page.evaluate(() => {
    const summary = [];
    const tables = document.querySelectorAll('table');
    tables.forEach((t, idx) => {
      const rows = t.querySelectorAll('tr').length;
      const cls = String(t.className).slice(0, 80);
      const firstRowText = t.querySelector('tr') ? t.querySelector('tr').innerText.slice(0, 120) : '';
      summary.push({ idx, rows, cls, firstRowText });
    });
    const headingInfo = [];
    [...document.querySelectorAll('div,span,h1,h2,h3,p')].forEach((el) => {
      const txt = (el.textContent || '').trim();
      if (['门店数据', '咨询数据', '医生数据'].includes(txt) && el.children.length === 0) {
        let parent = el;
        for (let k = 0; k < 5 && parent.parentElement; k++) parent = parent.parentElement;
        const tbl = parent.querySelector('table');
        headingInfo.push({
          heading: txt,
          parentCls: String(parent.className).slice(0, 100),
          hasTable: !!tbl,
          tableRows: tbl ? tbl.querySelectorAll('tr').length : 0,
          sampleHtml: parent.innerHTML.slice(0, 2000),
        });
      }
    });
    return { tableCount: tables.length, summary, headingInfo, bodyCls: String(document.body.className) };
  });
  fs.writeFileSync(path.join(OUT, 'dom_info.json'), JSON.stringify(info, null, 2), 'utf-8');
  fs.writeFileSync(path.join(OUT, 'page.html'), await page.content(), 'utf-8');
  await browser.close();
  console.log('RECON2 DONE');
})().catch((e) => {
  console.error('RECON2 FAILED:', e.message);
  process.exit(1);
});
