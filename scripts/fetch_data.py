# -*- coding: utf-8 -*-
"""宏脉BI 报表取数:无头浏览器登录 → 提取三张表 → 写 JSON。

凭据走环境变量 BI_USER / BI_PASS,绝不写进代码。
本地调试可设 CHROME_PATH 指向已装的 Chrome;Actions 里用 playwright 自装的 chromium。
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone
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

# 定位网格:返回每张待抽取表的 .simpleGrid 中心坐标(供 mouse.move 用)。
# 帆软虚拟表格只认真实滚轮/指针事件,直接改 scrollTop 或撑开容器都无法触发它渲染下面的行,
# 所以策略改为:鼠标移到网格上 → page.mouse.wheel 逐段下滚 → 每段等渲染后抽取 → 跨轮累计去重。
GRID_BOX_JS = """
(targets) => {
  const out = {};
  for (const t of targets) {
    const el = [...document.querySelectorAll('div,span,h1,h2,h3,p')]
      .find(e => e.children.length === 0 && e.textContent.trim() === t);
    if (!el) { out[t] = null; continue; }
    let box = el;
    while (box && box.getAttribute && box.getAttribute('data-elemtype') == null && box.parentElement) {
      box = box.parentElement;
    }
    const grid = box.querySelector('.simpleGrid');
    if (!grid) { out[t] = null; continue; }
    const r = grid.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) { out[t] = null; continue; }
    out[t] = {
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + Math.min(r.height / 2, 300))
    };
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


CN_TZ = timezone(timedelta(hours=8))  # Actions 服务器是 UTC,固定成北京时间


def now_cn():
    return datetime.now(CN_TZ)


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
        "updated_at": now_cn().strftime("%Y-%m-%d %H:%M"),
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
        # 视口拉高:帆软 simpleGrid 只渲染"可见区"内的行,可见区大小随视口高度变化。
        # CI 默认 1080 高只装得下约 8 行,故本地能抓全(15/25)而 CI 只抓 8/8。
        # 拉到 4000 让所有表所有行一次性进 DOM,首轮即可抓全,无需滚动。
        page = browser.new_page(viewport={"width": 1920, "height": 4000})
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

        # 轮询抽取 + 渐进滚动:
        #  - 标题/网格/数据可能延迟渲染(Exploded 型约 20s+),需等待
        #  - 表格可能只渲染可视区(虚拟滚动),需逐步滚动滚动容器,跨轮累计去重才能拿到全部行
        # 累计策略:同一行用"各单元格拼接"作签名去重,这样无论分几轮、滚到哪,全集都能凑齐且不重复
        raw_rows = {name: {} for name in TABLE_NAMES}     # name -> {签名: 行}
        raw_header = {name: None for name in TABLE_NAMES}
        stable = {name: 0 for name in TABLE_NAMES}        # 连续几轮无新增
        wheel_step = {name: 0 for name in TABLE_NAMES}    # 每张表自己的滚轮步数(表刚出现先滚0抓顶部)
        pending = list(TABLE_NAMES)
        for i in range(30):
            if not pending:
                break
            # 模拟真实滚轮:鼠标移到每张待抽取表的网格上向下滚。
            # 关键:步数按"每张表自己出现后的轮数"算,不能用全局轮数——
            # 否则慢表(渲染20s+)出现时全局已轮9+,一上来就滚到底,只抓到最后一行"合计"。
            try:
                boxes = page.evaluate(GRID_BOX_JS, pending)
            except Exception as e:
                boxes = {}
                print("定位跳过:", e)
            for t in pending:
                b = boxes.get(t)
                if not b:
                    continue
                try:
                    page.mouse.move(min(b["x"], 1910), min(b["y"], 3980))
                    page.mouse.wheel(0, 200 * wheel_step[t])
                    wheel_step[t] += 1
                except Exception as e:
                    print("滚轮跳过:", e)
            page.wait_for_timeout(5000)
            res = page.evaluate(SCROLL_EXTRACT_JS, pending)
            for name, rows in res.items():
                if isinstance(rows, list) and len(rows) >= 2:
                    raw_header[name] = rows[0]
                    added = 0
                    for r in rows[1:]:
                        sig = "\u0001".join("" if v is None else str(v) for v in r)
                        if sig not in raw_rows[name]:
                            raw_rows[name][sig] = r
                            added += 1
                    stable[name] = stable[name] + 1 if added == 0 else 0
            pending = [t for t in TABLE_NAMES if raw_header.get(t) is None or stable.get(t, 0) < 2]
            print(f"round {i + 1}: 各表行数={ {n: len(raw_rows[n]) for n in TABLE_NAMES} } 待抽取={pending}")
        page.wait_for_timeout(2000)
        browser.close()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ok = []
    for name in TABLE_NAMES:
        header = raw_header[name]
        data_rows = list(raw_rows[name].values())
        rows_arg = [header] + data_rows if header else None
        payload = build_payload(name, rows_arg)
        out = OUT_DIR / f"{FILE_KEYS[name]}.json"
        with open(out, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        ok.append(f"{name}: {len(data_rows)} 行 -> {out.name}")
    print("\n".join(ok))
    # 不因某张表为空而整体失败:仅打印警告,保证其它表正常发布
    for n in TABLE_NAMES:
        p = json.load(open(OUT_DIR / f"{FILE_KEYS[n]}.json", encoding="utf-8"))
        if not p["rows"]:
            print(f"警告: {n} 提取为空,请检查页面结构或标题是否一致")


if __name__ == "__main__":
    main()
