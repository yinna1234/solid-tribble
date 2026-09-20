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
TABLE_NAMES = ["门店数据", "咨询数据", "医生数据", "网电数据", "市场数据", "老带新数据"]
FILE_KEYS = {
    "门店数据": "stores",
    "咨询数据": "consults",
    "医生数据": "doctors",
    "网电数据": "web",
    "市场数据": "market",
    "老带新数据": "referral",
}
OUT_DIR = Path(__file__).resolve().parent.parent / "site" / "data"

# 两种表格组件:
#  - Table 型(门店/咨询/医生):表头在 .tr_sticky,数据在 .bottom_right
#  - Exploded 型(网电/市场/老带新):没有 .tr_sticky,表头就是 .bottom_right 的第一行
# 标题找到但内容未渲染时返回 undefined(继续等),渲染完成返回 [表头, ...行]。
SCROLL_EXTRACT_JS = """
(targets) => {
  const out = {};
  for (const t of targets) {
    const el = [...document.querySelectorAll('div,span,h1,h2,h3,p')]
      .find(e => e.children.length === 0 && e.textContent.trim() === t);
    if (!el) { out[t] = undefined; continue; }
    let box = el;
    while (box && box.getAttribute && box.getAttribute('data-elemtype') == null && box.parentElement) {
      box = box.parentElement;
    }
    const grid = box.querySelector('.simpleGrid');
    if (!grid) { out[t] = undefined; continue; }
    const headerRow = grid.querySelector('.tr_sticky');
    const br = grid.querySelector('.bottom_right');
    if (!br || br.children.length === 0) { out[t] = undefined; continue; }
    const groups = new Map();
    for (const cell of br.children) {
      const top = parseInt(cell.style.top || '0', 10);
      const left = parseInt(cell.style.left || '0', 10);
      if (!groups.has(top)) groups.set(top, []);
      groups.get(top).push({ left, text: cell.innerText.trim() });
    }
    let rows = [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, cells]) => cells.sort((a, b) => a.left - b.left).map(c => c.text));
    let header;
    if (headerRow) {
      header = [...headerRow.children].map(c => c.innerText.trim());
    } else {
      header = rows.shift() || [];
    }
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

        # 轮询抽取:标题/网格/数据可能延迟渲染(Exploded 型约 20s+),最多 15 轮
        # 只有抽到非空数组才算完成,否则下一轮重试
        raw = {}
        pending = list(TABLE_NAMES)
        for i in range(15):
            if not pending:
                break
            page.wait_for_timeout(5000)
            res = page.evaluate(SCROLL_EXTRACT_JS, pending)
            for name, rows in res.items():
                if isinstance(rows, list) and rows:
                    raw[name] = rows
            pending = [t for t in TABLE_NAMES if t not in raw]
            print(f"round {i + 1}: 已抽取={list(raw.keys())} 待抽取={pending}")
        page.wait_for_timeout(2000)
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
    # 不因某张表为空而整体失败:仅打印警告,保证其它表正常发布
    for n in TABLE_NAMES:
        p = json.load(open(OUT_DIR / f"{FILE_KEYS[n]}.json", encoding="utf-8"))
        if not p["rows"]:
            print(f"警告: {n} 提取为空,请检查页面结构或标题是否一致")


if __name__ == "__main__":
    main()
