# -*- coding: utf-8 -*-
"""宏脉BI 报表取数:无头浏览器登录 → 提取三张表 → 写 JSON。

凭据走环境变量 BI_USER / BI_PASS,绝不写进代码。
本地调试可设 CHROME_PATH 指向已装的 Chrome;Actions 里用 playwright 自装的 chromium。
"""
import json
import os
import sys
from datetime import datetime
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "https://bi.hmccloud.com"
VIEWER_URL = (
    BASE + "/bi/viewer?proc=1&action=viewer&hback=true"
    "&db=__MY_DB__!2f!2026!5468!!5e74!!5e86!!2f!!6570!!636e!!96c6!!8868!!683c!.db"
)
TABLE_NAMES = ["门店数据", "咨询数据", "医生数据"]
FILE_KEYS = {"门店数据": "stores", "咨询数据": "consults", "医生数据": "doctors"}
OUT_DIR = Path(__file__).resolve().parent.parent / "site" / "data"

EXTRACT_JS = """
(targets) => {
  const out = {};
  for (const t of targets) {
    const els = [...document.querySelectorAll('div,span,h1,h2,h3,p')]
      .filter(el => el.children.length === 0 && el.textContent.trim() === t);
    if (!els.length) { out[t] = null; continue; }
    let parent = els[0];
    for (let k = 0; k < 5 && parent.parentElement; k++) parent = parent.parentElement;
    const grid = parent.querySelector('.simpleGrid');
    if (!grid) { out[t] = null; continue; }
    const headerRow = grid.querySelector('.tr_sticky');
    if (!headerRow) { out[t] = null; continue; }
    const header = [...headerRow.children].map(c => c.innerText.trim());

    const body = headerRow.nextElementSibling || grid.querySelector('.bottom_right');
    if (!body) { out[t] = null; continue; }
    const groups = new Map();
    for (const cell of body.children) {
      const top = parseInt(cell.style.top || '0', 10);
      const left = parseInt(cell.style.left || '0', 10);
      if (!groups.has(top)) groups.set(top, []);
      groups.get(top).push({ left, text: cell.innerText.trim() });
    }
    const rows = [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, cells]) => cells.sort((a, b) => a.left - b.left).map(c => c.text));
    out[t] = [header, ...rows];
  }
  return out;
}
"""


def get_credentials():
    user = os.environ.get("BI_USER")
    pwd = os.environ.get("BI_PASS")
    if not user or not pwd:
        sys.exit("缺少环境变量 BI_USER / BI_PASS")
    return user, pwd


def to_number(s):
    """'2,465,912.1' -> 2465912.1;'112.09%' -> 112.09;失败返回原字符串"""
    if not isinstance(s, str):
        return s
    t = s.replace(",", "").replace("%", "").strip()
    try:
        v = float(t)
        return v
    except ValueError:
        return s


def build_payload(name, rows):
    if not rows or len(rows) < 2:
        return {"columns": [], "rows": [], "empty": True}
    header = rows[0]
    data = []
    for r in rows[1:]:
        if not any(r):
            continue
        item = {}
        for i, col in enumerate(header):
            val = r[i] if i < len(r) else ""
            item[col] = to_number(val)
        data.append(item)
    return {
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "source": "宏脉BI报表平台",
        "table": name,
        "columns": header,
        "rows": data,
    }


def main():
    user, pwd = get_credentials()
    chrome_path = os.environ.get("CHROME_PATH") or None

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=chrome_path)
        page = browser.new_page(viewport={"width": 1920, "height": 1080})
        page.goto(VIEWER_URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(5000)

        inputs = page.locator("input")
        user_input = pass_input = None
        for i in range(inputs.count()):
            el = inputs.nth(i)
            t = el.get_attribute("type") or ""
            if t == "password":
                pass_input = el
            elif user_input is None and t not in ("hidden", "checkbox", "radio"):
                user_input = el
        if user_input is None or pass_input is None:
            sys.exit("未找到登录输入框,页面结构可能变了")

        user_input.fill(user)
        pass_input.fill(pwd)
        pass_input.press("Enter")

        # 等三个标题都渲染出来,最多 60s
        deadline = 60
        elapsed = 0
        while elapsed < deadline:
            page.wait_for_timeout(3000)
            elapsed += 3
            ready = page.evaluate(
                "(ts) => ts.every(t => [...document.querySelectorAll('div,span')]"
                ".some(el => el.children.length === 0 && el.textContent.trim() === t))",
                TABLE_NAMES,
            )
            if ready:
                break
        page.wait_for_timeout(3000)

        raw = page.evaluate(EXTRACT_JS, TABLE_NAMES)
        browser.close()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ok = []
    for name in TABLE_NAMES:
        payload = build_payload(name, raw.get(name))
        out = OUT_DIR / f"{FILE_KEYS[name]}.json"
        with open(out, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        n = len(payload["rows"])
        ok.append(f"{name}: {n} 行 -> {out.name}")
    print("\n".join(ok))
    if any(json.load(open(OUT_DIR / f"{FILE_KEYS[n]}.json", encoding="utf-8"))["rows"] == [] for n in TABLE_NAMES):
        sys.exit("有表格提取为空,请检查页面结构")


if __name__ == "__main__":
    main()
