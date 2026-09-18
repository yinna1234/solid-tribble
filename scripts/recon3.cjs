/* 第三轮:dump grid 行容器的子元素结构 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:\\Users\\Y\\.agent-browser\\browsers\\chrome-153.0.8010.52\\chrome.exe';
const VIEWER_URL =
  'https://bi.hmccloud.com/bi/viewer?proc=1&action=viewer&hback=true&db=__MY_DB__!2f!2026!5468!!5e74!!5e86!!2f!!6570!!636e!!96c6!!8868!!683c!.db';
const OUT = path.join(__dirname, '..', 'recon');

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
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
    const el = [...document.querySelectorAll('div,span')].find(
      (e) => e.children.length === 0 && e.textContent.trim() === '门店数据'
    );
    let parent = el;
    for (let k = 0; k < 5 && parent.parentElement; k++) parent = parent.parentElement;
    const grid = parent.querySelector('.simpleGrid');
    const content = grid.querySelector('.yh-scrollbar-content-container');
    const rowWrap = content.querySelector('div');
    const dump = (node, depth) => {
      const o = {
        tag: node.tagName,
        cls: String(node.className).slice(0, 50),
        h: node.style ? node.style.height : '',
        text: (node.innerText || '').split('\n').slice(0, 3).join('|').slice(0, 80),
        children: [],
      };
      if (depth > 0) {
        for (const c of [...node.children].slice(0, 8)) o.children.push(dump(c, depth - 1));
      }
      return o;
    };
    return {
      rowWrapChildCount: rowWrap.children.length,
      tree: dump(rowWrap, 3),
    };
  });
  fs.writeFileSync(path.join(OUT, 'grid_tree.json'), JSON.stringify(info, null, 2), 'utf-8');
  await browser.close();
  console.log('RECON3 DONE');
})().catch((e) => {
  console.error('RECON3 FAILED:', e.message);
  process.exit(1);
});
