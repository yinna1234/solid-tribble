/* 探测宏脉BI:自动登录,记录所有网络请求,保存 JSON 响应体 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:\\Users\\Y\\.agent-browser\\browsers\\chrome-153.0.8010.52\\chrome.exe';
const VIEWER_URL =
  'https://bi.hmccloud.com/bi/viewer?proc=1&action=viewer&hback=true&db=__MY_DB__!2f!2026!5468!!5e74!!5e86!!2f!!6570!!636e!!96c6!!8868!!683c!.db';
const OUT = path.join(__dirname, '..', 'recon');

fs.mkdirSync(OUT, { recursive: true });
const log = fs.createWriteStream(path.join(OUT, 'requests.jsonl'));

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  const bodies = {};

  page.on('response', async (resp) => {
    const req = resp.request();
    let ct = '';
    try { ct = resp.headers()['content-type'] || ''; } catch (e) {}
    log.write(
      JSON.stringify({ method: req.method(), url: resp.url(), status: resp.status(), ct }) + '\n'
    );
    if ((ct.includes('json') || ct.includes('text/plain')) && req.method() !== 'OPTIONS') {
      try {
        const body = await resp.text();
        if (body && body.length < 800000) bodies[resp.url()] = body;
      } catch (e) {}
    }
  });

  await page.goto(VIEWER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  const dom = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')].map((i) => ({
      type: i.type, name: i.name, id: i.id, placeholder: i.placeholder, cls: String(i.className).slice(0, 60),
    }));
    const buttons = [...document.querySelectorAll('button, input[type=submit], .submit, a.login, [class*=login]')]
      .slice(0, 20)
      .map((b) => ({ tag: b.tagName, text: (b.textContent || b.value || '').trim().slice(0, 30), id: b.id, cls: String(b.className).slice(0, 60) }));
    return { url: location.href, title: document.title, inputs, buttons, bodyText: document.body.innerText.slice(0, 800) };
  });
  fs.writeFileSync(path.join(OUT, 'form.json'), JSON.stringify(dom, null, 2));

  const user = process.env.BI_USER;
  const pwd = process.env.BI_PASS;
  if (user && pwd) {
    const inputs = await page.$$('input');
    let userInput = null;
    let passInput = null;
    for (const i of inputs) {
      const t = (await i.getAttribute('type')) || '';
      if (t === 'password') passInput = i;
      else if (!userInput && t !== 'hidden' && t !== 'checkbox' && t !== 'radio') userInput = i;
    }
    if (userInput && passInput) {
      await userInput.fill(user);
      await passInput.fill(pwd);
      await passInput.press('Enter');
      await page.waitForTimeout(8000);
    } else {
      fs.writeFileSync(path.join(OUT, 'login_fields_not_found.txt'), 'no username/password inputs');
    }
    fs.writeFileSync(path.join(OUT, 'after_login_url.txt'), page.url());
    await page.screenshot({ path: path.join(OUT, 'after_login.png') });
    await page.waitForTimeout(10000);
    const tables = await page.evaluate(() => document.body.innerText.slice(0, 4000));
    fs.writeFileSync(path.join(OUT, 'page_text.txt'), tables, 'utf-8');
    await page.screenshot({ path: path.join(OUT, 'final.png'), fullPage: true });
  }

  fs.writeFileSync(path.join(OUT, 'bodies.json'), JSON.stringify(bodies, null, 2));
  await browser.close();
  log.end();
  console.log('RECON DONE');
})().catch((e) => {
  console.error('RECON FAILED:', e.message);
  process.exit(1);
});
