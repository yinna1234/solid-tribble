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
TABLE_NAMES = ["门店数据", "咨询数据", "医生数据", "网电数据", "市场数据", "老带新数据", "门店每日数据"]
FILE_KEYS = {
    "门店数据": "stores",
    "咨询数据": "consults",
    "医生数据": "doctors",
    "网电数据": "web",
    "市场数据": "market",
    "老带新数据": "referral",
    "门店每日数据": "daily",
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

# 定位网格:返回每张待抽取表的 .simpleGrid 中心坐标(供 mouse.move 用)及"是否已滚到底"标志。
# 帆软虚拟表格只认真实滚轮/指针事件,直接改 scrollTop 或撑开容器都无法触发它渲染下面的行,
# 所以策略改为:鼠标移到网格上 → page.mouse.wheel 逐段下滚 → 每段等渲染后抽取 → 跨轮累计去重。
# 自适应:通过滚动容器的 scrollTop/clientHeight/scrollHeight 判断是否到底,到底即停止滚动,
# 配合"连续2轮无新增"判定该表抓全 —— 不再依赖固定轮数,表多大就滚多大(45天×5店也不会漏行)。
GRID_BOX_JS = """
(targets) => {
  const findScroller = (node) => {
    let n = node;
    while (n) {
      const style = getComputedStyle(n);
      if (n.scrollHeight > n.clientHeight + 2 &&
          (style.overflowY === 'auto' || style.overflowY === 'scroll')) {
        return n;
      }
      n = n.parentElement;
    }
    return node;
  };
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
    const sc = findScroller(grid);
    const sh = sc.scrollHeight, ch = sc.clientHeight, st = sc.scrollTop;
    const atBottom = sh <= ch + 2 || (st + ch >= sh - 4);
    out[t] = {
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + Math.min(r.height / 2, 300)),
      atBottom
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


def login(page, user, pwd):
    """打开报表页并登录。页面偶发自行导航(会话超时等)导致执行上下文销毁时,用它恢复。"""
    page.goto(VIEWER_URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(3000)
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
        return False
    user_input.fill(user)
    pass_input.fill(pwd)
    pass_input.press("Enter")
    return True


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
        if not login(page, user, pwd):
            sys.exit("未找到登录输入框,页面结构可能变了")

        # 轮询抽取 + 渐进滚动:
        #  - 标题/网格/数据可能延迟渲染(Exploded 型约 20s+),需等待
        #  - 表格可能只渲染可视区(虚拟滚动),需逐步滚动滚动容器,跨轮累计去重才能拿到全部行
        # 累计策略:同一行用"各单元格拼接"作签名去重,这样无论分几轮、滚到哪,全集都能凑齐且不重复
        raw_rows = {name: {} for name in TABLE_NAMES}     # name -> {签名: 行}
        raw_header = {name: None for name in TABLE_NAMES}
        stable = {name: 0 for name in TABLE_NAMES}        # 连续几轮无新增
        at_bottom = {name: False for name in TABLE_NAMES}  # 该表是否已滚到底(自适应退出用)
        pending = list(TABLE_NAMES)
        eval_fail_streak = 0  # 连续抽取失败次数(页面导航/会话过期会导致执行上下文销毁)
        # 自适应滚动:不再靠固定轮数,而是每张表滚到自己的底部(atBottom)且连续2轮无新增才判定抓全。
        # 上限 150 轮仅作兜底(约覆盖 600 行,远大于 45天×5店=225 行),正常会在各表到底后自动退出。
        for i in range(150):
            if not pending:
                break
            # 模拟真实滚轮:鼠标移到每张待抽取表的网格上,每轮向下滚 240px(约 8~9 行)。
            # 步长 240px 仍保证相邻采样窗口大量重叠(视口约 28 行,重叠约 19 行),
            # 确保中间每一行都至少落入一个窗口被抓到,不会像大步跳那样漏掉缝隙里的行。
            # 注意:每轮对所有待抓表都照常滚动(沿用已验证有效的机制);at_bottom 只参与"是否抓全"判定,
            # 不用来跳过滚动 —— 否则一旦帆软滚动容器被误判为"已到底",会提前退出而漏抓行。
            try:
                boxes = page.evaluate(GRID_BOX_JS, pending)
            except Exception as e:
                boxes = {}
                print("定位跳过:", e)
            for t in pending:
                b = boxes.get(t)
                if not b:
                    continue
                at_bottom[t] = bool(b.get("atBottom"))
                try:
                    page.mouse.move(min(b["x"], 1910), min(b["y"], 3980))
                    page.mouse.wheel(0, 240)
                except Exception as e:
                    print("滚轮跳过:", e)
            page.wait_for_timeout(1500)
            # 抓取也容错:页面偶发自行导航(会话超时等)会销毁执行上下文,这里不能让单次失败炸掉整个进程。
            # 已抓到的行有签名去重累计着,跳一轮不丢数据;连续失败则重新登录恢复会话。
            try:
                res = page.evaluate(SCROLL_EXTRACT_JS, pending)
                eval_fail_streak = 0
            except Exception as e:
                eval_fail_streak += 1
                print("抽取跳过:", e)
                if eval_fail_streak >= 3:
                    print("连续抽取失败,尝试重新登录恢复会话")
                    try:
                        if login(page, user, pwd):
                            eval_fail_streak = 0
                        else:
                            print("重新登录未找到输入框,下轮继续重试")
                    except Exception as e2:
                        print("重新登录失败:", e2)
                continue
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
            # 判定抓全:① 已拿到表头;② 该表已滚到底;③ 连续2轮无新增。
            # 任一未满足则继续(尤其大表没到底前,即使某轮无新增也不提前退出,防止漏抓前面行)。
            pending = [
                t for t in TABLE_NAMES
                if raw_header.get(t) is None or not (at_bottom.get(t, False) and stable.get(t, 0) >= 2)
            ]
            print(f"round {i + 1}: 各表行数={ {n: len(raw_rows[n]) for n in TABLE_NAMES} } 到底={ {n: at_bottom[n] for n in TABLE_NAMES} } 待抽取={pending}")
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
