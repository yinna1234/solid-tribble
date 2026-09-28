/* 13周年庆数据看板 · 渲染层（js/main.js）
   版式与交互与 v2 单文件版完全一致；数据来自 js/data.js 装配的 BI 爬虫 JSON。
   以 <script type="module"> 引入：顶层 await 先取数，再按原流程一次性建板。 */
/* ══════════════════════════════════════════════════════════
       * ① 数据层：全部来自 BI 爬虫 JSON（js/data.js 装配，每 10 分钟更新）
       * ══════════════════════════════════════════════════════════ */
      const DATA = await loadDashboardData();
      const CAMPAIGN = DATA.campaign;
      const SPRINT_K = DATA.sprintK;
      const STORES = DATA.stores;
      const CHANNELS = DATA.channels;
      const STAFF = DATA.staff;

/* ══════════════════════════════════════════════════════════
       * ② 工具（沿用「进度水球」的几何与缓动套路）
       * ══════════════════════════════════════════════════════════ */
      const SVGNS = "http://www.w3.org/2000/svg";
      const $ = (id) => document.getElementById(id);
      const ANIM = !/[?&]static=1/.test(location.search);
      if (!ANIM) document.documentElement.classList.add("noanim");
      /* 数据心跳：间隔与初始拍（调试参数） */
      const HB_MS = (() => {
        const m = /[?&]hbms=(\d+)/.exec(location.search);
        return m ? Math.max(1000, +m[1]) : 498000;
      })();
      const norm = (a) => ((a % 360) + 360) % 360;
      const easeOut = (t) => 1 - Math.pow(1 - t, 3);
      const lerp = (a, b, t) => a + (b - a) * t;
      const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
      const fmtW = (v) =>
        v.toLocaleString("zh-CN", { maximumFractionDigits: 1 });
      const fmtI = (v) => Math.round(v).toLocaleString("zh-CN");
      function polar(cx, cy, r, deg) {
        const a = (deg * Math.PI) / 180;
        return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      }
      function arcPath(cx, cy, r, a0, a1) {
        const [x0, y0] = polar(cx, cy, r, a0);
        const [x1, y1] = polar(cx, cy, r, a1);
        const large = norm(a1 - a0) > 180 ? 1 : 0;
        return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
      }
      /* 方向感知弧线（水球组件原版）：dir=-1 时必须走逆时针短弧，
         否则左侧三段会画成 320°+ 的大弧叠满整圈（v2 首版踩过的坑） */
      function arcPathDir(r, a0, a1, dir) {
        const [x0, y0] = polar(H.CX, H.CY, r, a0);
        const [x1, y1] = polar(H.CX, H.CY, r, a1);
        const delta = dir > 0 ? norm(a1 - a0) : norm(a0 - a1); // 沿绘制方向的角距
        const large = delta > 180 ? 1 : 0;
        const sweep = dir > 0 ? 1 : 0;
        return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
      }
      const p2 = (n) => String(n).padStart(2, "0");
      /* 心跳刷新用的补间：tween(dur, fn) 逐帧回调，tweenNum 数字滚动 */
      function tween(dur, fn, done) {
        const t0 = performance.now();
        (function f(now) {
          const k = easeOut(clamp((now - t0) / dur, 0, 1));
          fn(k);
          if (k < 1) requestAnimationFrame(f);
          else done && done();
        })(t0);
      }
      function tweenNum(el, from, to, fmt, dur = 900) {
        tween(dur, (k) => (el.textContent = fmt(lerp(from, to, k))));
      }

      /* ══════════════════════════════════════════════════════════
       * ③ 舞台等比缩放
       * ══════════════════════════════════════════════════════════ */
      const stage = $("stage");
      let SCALE = 1;
      function syncStage() {
        SCALE = Math.min(innerWidth / 1920, innerHeight / 1080);
        stage.style.setProperty("--s", SCALE);
      }
      syncStage();
      addEventListener("resize", syncStage);

            /* ══════════════════════════════════════════════════════════
       * ④ 数据派生（真实 BI 数据，不再随机模拟；心跳=重新抓取 JSON）
       * ══════════════════════════════════════════════════════════ */
      const T = CAMPAIGN.today,
        D = CAMPAIGN.monthDays;
      const sumOf = (arr, fn) => arr.reduce((a, x) => a + fn(x), 0);
      const totalBase = DATA.totals.totalBase;
      const totalRev = DATA.totals.totalRev;
      const totalInitBase = DATA.totals.totalInitBase;
      const totalInit = DATA.totals.totalInit;
      const sprintOf = (base) => base * SPRINT_K;
      const actualOf = (s) => s.actual;
      const initActualOf = (s) => s.initActual;
      const dailyByStore = DATA.daily.byId;
      const dailyAll = DATA.daily.all;

      const KPI = DATA.kpi;
      /* 当前生效的数据模型（首次 = 刚抓到的 JSON；5 分钟心跳后会整体替换） */
      let MODEL = DATA.model;
      /* 底部更新时间 = BI 爬虫写入 JSON 的 updated_at（7 张表里最新的一个） */
      const setFoot = (t) =>
        ($("footUpdated").textContent = "更新于 " + (t || "--") + " ·");
      setFoot(DATA.updatedAt);

/* ══════════════════════════════════════════════════════════
       * ⑤ KPI 行：环形 + 数字滚动 + 渠道 chip
       * ══════════════════════════════════════════════════════════ */
      function buildRing(svg, pct, color) {
        const CX = 38,
          CY = 38,
          R = 29,
          ST = 7;
        svg.innerHTML = "";
        const mk = (tag, attrs) => {
          const el = document.createElementNS(SVGNS, tag);
          for (const k in attrs) el.setAttribute(k, attrs[k]);
          svg.appendChild(el);
          return el;
        };
        mk("path", {
          d: arcPath(CX, CY, R, 135, 405),
          fill: "none",
          stroke: "rgba(255,255,255,0.12)",
          "stroke-width": ST,
          "stroke-linecap": "round",
        });
        const prog = mk("path", {
          fill: "none",
          stroke: color,
          "stroke-width": ST,
          "stroke-linecap": "round",
          filter: "url(#tGlow)",
        });
        const dot = mk("circle", { r: 3, fill: "#fff" });
        const txt = mk("text", {
          x: CX,
          y: CY + 5,
          "text-anchor": "middle",
          class: "ring-txt",
        });
        return (p) => {
          if (p < 0.5) {
            prog.setAttribute("d", "");
            dot.setAttribute("r", 0);
          } else {
            prog.setAttribute(
              "d",
              arcPath(CX, CY, R, 135, 135 + (270 * p) / 100),
            );
            const [x, y] = polar(CX, CY, R, 135 + (270 * p) / 100);
            dot.setAttribute("cx", x.toFixed(2));
            dot.setAttribute("cy", y.toFixed(2));
            dot.setAttribute("r", 3);
          }
          txt.textContent = p.toFixed(1) + "%";
        };
      }
      const drawRT = buildRing($("rTime"), KPI.timePct, "#e8c25f");
      const drawRR = buildRing($("rRev"), KPI.revPct, "#f0cf7a");
      const drawRI = buildRing($("rInit"), KPI.initPct, "#e8c25f");
      $("subTime").textContent = `第 ${T} 天 / 共 ${D} 天`;
      $("subRev").textContent =
        `基础 ${fmtI(totalBase)} 万 · 冲刺 ${fmtI(sprintOf(totalBase))} 万`;
      $("subInit").textContent =
        `基础 ${fmtI(totalInitBase)} 人 · 客单 ${fmtI(KPI.avgTicket)} 元`;

      let chipRefs = [];
      function renderChannels(m) {
        $("chChips").innerHTML = m.channels
          .map((c) => {
            return `<div class="chip">
            <div class="chip-name"><span class="dot" style="background:${c.color}"></span>${c.name}</div>
            <div class="chip-val"><b>${c.cum}</b>人 · 占比 ${Math.round(c.share * 100)}%</div>
            <div class="chip-bar"><i data-w="${Math.round(c.share * 100)}"></i></div>
            <div class="chip-val" style="line-height:18px">今日 <b style="font-size:14px">${c.today}</b> · 到诊 ${c.rate.toFixed(0)}%</div>
          </div>`;
          })
          .join("");
        chipRefs = [...$("chChips").children].map((el) => ({
          cum: el.querySelectorAll(".chip-val b")[0],
          val2: el.querySelectorAll(".chip-val")[1],
        }));
      }
      renderChannels(MODEL);
      function updateChannels(m) {
        m.channels.forEach((c, i) => {
          chipRefs[i].cum.textContent = c.cum;
          chipRefs[i].val2.innerHTML =
            `今日 <b style="font-size:14px">${c.today}</b> · 到诊 ${c.rate.toFixed(0)}%`;
        });
      }

      /* ══════════════════════════════════════════════════════════
       * ⑥ 中央 Hero：移植「门店业绩水球看板」
       * ══════════════════════════════════════════════════════════ */
      const H = {
        CX: 450,
        CY: 320,
        R_RING: 233,
        R_BALL: 178,
        R_LABEL: 280,
        SEG_SPAN: 60,
        SEG_GAP: 2,
        STROKE: 30,
        VB_Y: 24,
        VB_W: 900,
        VB_H: 580,
      };
      /* 6 段：右上/右中/右下/左上/左中/左下（与 STORES 一一对应）
         mirror 模式：右侧顺时针涨、左侧逆时针涨，以垂直中轴严格镜像 */
      const SEGMENTS = [
        { slot: "right-top", start: 270, dir: 1 },
        { slot: "right-mid", start: 330, dir: 1 },
        { slot: "right-bottom", start: 30, dir: 1 },
        { slot: "left-top", start: 210, dir: -1 },
        { slot: "left-mid", start: 150, dir: -1 },
        { slot: "left-bottom", start: 90, dir: -1 },
      ];
      const trackRange = (seg) => ({
        a0: seg.start + H.SEG_GAP,
        a1: seg.start + H.SEG_SPAN - H.SEG_GAP,
      });
      function progressRange(seg, pct) {
        const t = trackRange(seg);
        const len = ((H.SEG_SPAN - 2 * H.SEG_GAP) * clamp(pct, 0, 100)) / 100;
        const a0 = seg.dir > 0 ? t.a0 : t.a1;
        return { a0, a1: a0 + seg.dir * len, dir: seg.dir };
      }

      const heroMod = $("heroMod");
      const gTracks = $("hTracks"),
        gProgress = $("hProgress"),
        gDots = $("hDots"),
        gHits = $("hHits");
      const progPaths = [],
        endDots = [],
        hitPaths = [],
        labels = [];
      const U = () => heroMod.clientWidth / H.VB_W; // 800/900 = 0.8889
      function syncUnit() {
        heroMod.style.setProperty("--u", U() + "px");
      }
      syncUnit();
      addEventListener("resize", syncUnit);

      SEGMENTS.slice(0, STORES.length).forEach((seg, i) => {
        const t = trackRange(seg),
          s = STORES[i];
        const mkP = (parent, attrs) => {
          const el = document.createElementNS(SVGNS, "path");
          for (const k in attrs) el.setAttribute(k, attrs[k]);
          parent.appendChild(el);
          return el;
        };
        mkP(gTracks, {
          d: arcPath(H.CX, H.CY, H.R_RING, t.a0, t.a1),
          stroke: "rgba(255,255,255,0.12)",
        });
        progPaths[i] = mkP(gProgress, { stroke: s.color });
        const c = document.createElementNS(SVGNS, "circle");
        c.setAttribute("r", 0);
        c.setAttribute("fill", "#fff");
        c.setAttribute("filter", "url(#hGlow)");
        gDots.appendChild(c);
        endDots[i] = c;
        hitPaths[i] = mkP(gHits, {
          d: arcPath(H.CX, H.CY, H.R_RING, t.a0, t.a1),
        });
      });

      function drawProgress(i, pct) {
        if (pct < 0.5) {
          progPaths[i].setAttribute("d", "");
          endDots[i].setAttribute("r", 0);
          return;
        }
        const rg = progressRange(SEGMENTS[i], pct);
        progPaths[i].setAttribute(
          "d",
          arcPathDir(H.R_RING, rg.a0, rg.a1, rg.dir),
        );
        const [x, y] = polar(H.CX, H.CY, H.R_RING, rg.a1);
        endDots[i].setAttribute("cx", x.toFixed(2));
        endDots[i].setAttribute("cy", y.toFixed(2));
        endDots[i].setAttribute("r", (H.STROKE / 2) * 0.75);
      }

      /* 水球波浪 */
      const WL = 160,
        WAVE_W = H.R_BALL * 2 + WL * 2 + 120;
      const wave1 = $("hWave1"),
        wave2 = $("hWave2");
      function wavePath(level, amp) {
        const x0 = H.CX - WAVE_W / 2;
        let d = `M ${x0} ${level.toFixed(2)}`,
          x = x0;
        while (x < x0 + WAVE_W) {
          d +=
            ` Q ${x + WL * 0.25} ${level - amp}, ${x + WL * 0.5} ${level}` +
            ` Q ${x + WL * 0.75} ${level + amp}, ${x + WL} ${level}`;
          x += WL;
        }
        return (
          d +
          ` L ${x0 + WAVE_W} ${H.CY + H.R_BALL + 60} L ${x0} ${H.CY + H.R_BALL + 60} Z`
        );
      }
      function drawWaves(pct) {
        const lv = H.CY + H.R_BALL - (2 * H.R_BALL * clamp(pct, 0, 100)) / 100;
        wave1.setAttribute("d", wavePath(lv, 10));
        wave2.setAttribute("d", wavePath(lv + 9, 13));
      }

      /* 左右门店标签：y 由段中心角算出，与弧段严格对齐且左右镜像 */
      STORES.forEach((s, i) => {
        const seg = SEGMENTS[i];
        const center = seg.start + H.SEG_SPAN / 2;
        const y = H.CY + H.R_LABEL * Math.sin((center * Math.PI) / 180);
        const side = seg.slot.startsWith("right") ? "right" : "left";
        const el = document.createElement("div");
        el.className = `store-label ${side}`;
        el.style.top = (((y - H.VB_Y) / H.VB_H) * 100).toFixed(3) + "%";
        el.innerHTML = `
          <span class="dot" style="background:${s.color};color:${s.color}"></span>
          <div class="info">
            <div class="name">${s.name}</div>
            <div class="pct">0%</div>
            <div class="bar"><i style="background:${s.color}"></i></div>
          </div>`;
        heroMod.appendChild(el);
        labels[i] = el;
      });

      /* 主数字：宽度自动适配到「水球直径 × 73%」 */
      const hPct = $("hPct");
      const TARGET_W = 0.73 * 2 * H.R_BALL; // 259.9 用户单位
      function fitHeroNumber(text) {
        hPct.textContent = text;
        let fs = 84;
        for (let i = 0; i < 3; i++) {
          hPct.style.fontSize = fs + "px";
          const w = hPct.getComputedTextLength();
          if (!w) break;
          fs = clamp((fs * TARGET_W) / w, 40, 120);
        }
        hPct.style.fontSize = fs.toFixed(2) + "px";
      }
      fitHeroNumber(KPI.revPct.toFixed(1) + "%");

      /* 弧段 hover tooltip */
      const arcTip = $("arcTip");
      function labelTopPx(seg) {
        const center = seg.start + H.SEG_SPAN / 2;
        const y = H.CY + (H.R_RING + 34) * Math.sin((center * Math.PI) / 180);
        const x = H.CX + (H.R_RING + 34) * Math.cos((center * Math.PI) / 180);
        return [x * U(), (y - H.VB_Y) * U()];
      }
      function tipHTML(s) {
        const actual = actualOf(s),
          sprint = sprintOf(s.targetBase);
        return `<div class="hd"><span class="dot" style="background:${s.color}"></span>${s.name}</div>
          <div><span class="col">实收</span><b>${actual.toFixed(1)}</b> 万
            <span class="col">/ 基础 ${s.targetBase} 万</span></div>
          <div><span class="col">冲刺目标</span><b>${sprint.toFixed(0)}</b> 万
            <span class="col">· 完成</span><b>${s.revPct.toFixed(1)}%</b></div>
          <div><span class="col">累计初诊</span><b>${fmtI(initActualOf(s))}</b> 人
            <span class="col">· 复诊到店</span><b>${s.revisit}%</b></div>`;
      }
      SEGMENTS.slice(0, STORES.length).forEach((seg, i) => {
        hitPaths[i].style.cursor = "pointer";
        hitPaths[i].addEventListener("mouseenter", () => {
          heroMod.classList.add("focus");
          heroMod.classList.add("dim-others");
          progPaths.forEach((p, j) =>
            p.setAttribute("opacity", j === i ? 1 : 0.28),
          );
          endDots.forEach((d, j) =>
            d.setAttribute("opacity", j === i ? 1 : 0.28),
          );
          labels.forEach((l, j) => l.classList.toggle("on", j === i));
          arcTip.innerHTML = tipHTML(MODEL.stores[i]);
          const [x, y] = labelTopPx(seg);
          arcTip.style.display = "block";
          arcTip.style.left = clamp(x, 130, 670) + "px";
          arcTip.style.top = y - 10 + "px";
        });
        hitPaths[i].addEventListener("mouseleave", () => {
          heroMod.classList.remove("focus", "dim-others");
          progPaths.forEach((p) => p.setAttribute("opacity", 1));
          endDots.forEach((d) => d.setAttribute("opacity", 1));
          labels.forEach((l) => l.classList.remove("on"));
          arcTip.style.display = "none";
        });
      });

      /* ?hover=N 调试：模拟悬停第 N 段弧（截图核对 tooltip 用） */
      const hoverIdx = /[?&]hover=(\d)/.exec(location.search);
      if (hoverIdx)
        hitPaths[+hoverIdx[1]].dispatchEvent(new Event("mouseenter"));

      /* Hero 入场：弧长 / 水位 / 巨数同一进度驱动 */
      (function heroEnter() {
        if (!ANIM) {
          STORES.forEach((s, i) => {
            drawProgress(i, s.revPct);
            labels[i].querySelector(".pct").textContent =
              s.revPct.toFixed(1) + "%";
            labels[i].querySelector(".bar i").style.width =
              clamp(s.revPct, 0, 100) + "%";
          });
          drawWaves(KPI.revPct);
          hPct.textContent = KPI.revPct.toFixed(1) + "%";
          return;
        }
        const DUR = 1800,
          t0 = performance.now();
        (function frame(now) {
          const k = easeOut(clamp((now - t0) / DUR, 0, 1));
          STORES.forEach((s, i) => {
            drawProgress(i, s.revPct * k);
            labels[i].querySelector(".pct").textContent =
              (s.revPct * k).toFixed(1) + "%";
            labels[i].querySelector(".bar i").style.width =
              clamp(s.revPct * k, 0, 100) + "%";
          });
          drawWaves(KPI.revPct * k);
          hPct.textContent = (KPI.revPct * k).toFixed(1) + "%";
          if (k < 1) requestAnimationFrame(frame);
        })(t0);
      })();

      /* ══════════════════════════════════════════════════════════
       * ⑦ 左栏：门店达成 + 复诊到店率（32px 行，6 行闭合）
       * ══════════════════════════════════════════════════════════ */
      function renderRevRows(m) {
        $("rowsRev").innerHTML = m.stores
          .map((s) => {
            const actual = s.actual,
              sprint = sprintOf(s.targetBase);
            return `<div class="sp-row">
              <div class="sp-l1">
                <span class="dot" style="background:${s.color}"></span>
                <span class="sp-name">${s.name}</span>
                <span class="sp-meta">实收 ${actual.toFixed(1)} / 基础 ${s.targetBase} 万</span>
              </div>
              <div class="sp-bar-wrap">
                <span class="sp-bar"><i data-w="${clamp((actual / sprint) * 100, 0, 100).toFixed(1)}"></i><span class="tick"></span></span>
              </div>
              <span class="sp-pct">${s.revPct.toFixed(1)}%</span>
            </div>`;
          })
          .join("");
      }
      renderRevRows(MODEL);
      /* 心跳：门店顺序固定 → 原地更新，条形走 CSS 过渡、百分比走数字滚动 */
      function updateRevRows(m, animate) {
        const rows = $("rowsRev").children;
        m.stores.forEach((s, i) => {
          const row = rows[i];
          row.querySelector(".sp-meta").textContent =
            `实收 ${s.actual.toFixed(1)} / 基础 ${s.targetBase} 万`;
          row.querySelector(".sp-bar i").style.width =
            clamp((s.actual / sprintOf(s.targetBase)) * 100, 0, 100).toFixed(
              1,
            ) + "%";
          const pctEl = row.querySelector(".sp-pct");
          if (animate)
            tweenNum(
              pctEl,
              parseFloat(pctEl.textContent) || 0,
              s.revPct,
              (v) => v.toFixed(1) + "%",
              1100,
            );
          else pctEl.textContent = s.revPct.toFixed(1) + "%";
        });
      }

      /* setW=true：心跳重建后直接落位（入场时交给 entrance 统一铺开） */
      function renderRevisitRows(m, setW) {
        const list = [...m.stores].sort((a, b) => b.revisit - a.revisit);
        $("rowsRevisit").innerHTML = list
          .map((s) => {
            const arrive = Math.round((initActualOf(s) * s.revisit) / 100);
            return `<div class="sp-row">
              <div class="sp-l1">
                <span class="dot" style="background:${s.color}"></span>
                <span class="sp-name">${s.name}</span>
                <span class="sp-meta">到店 ${arrive} 人 / 初诊 ${fmtI(initActualOf(s))} 人</span>
              </div>
              <div class="sp-bar-wrap">
                <span class="sp-bar"><i data-w="${s.revisit}"></i></span>
              </div>
              <span class="sp-pct">${s.revisit}%</span>
            </div>`;
          })
          .join("");
        if (setW)
          $("rowsRevisit")
            .querySelectorAll("i[data-w]")
            .forEach((el) => (el.style.width = el.dataset.w + "%"));
        $("tagRevisit").textContent =
          `均值 ${(sumOf(m.stores, (s) => s.revisit) / m.stores.length).toFixed(1)}% · 按率降序`;
      }
      renderRevisitRows(MODEL, false);

      /* ══════════════════════════════════════════════════════════
       * ⑧ 右栏：顾问 / 医生 TOP7（28px 行，7 行闭合）
       * ══════════════════════════════════════════════════════════ */
      function renderRank(containerId, items, setW) {
        const max = Math.max(...items.map((p) => p.amount));
        const colorOf = (p) =>
          (STORES.find((s) => s.name === p.store) || {}).color || "#d4af37";
        $(containerId).innerHTML = items
          .map(
            (p, i) => `<div class="rk-row has-store">
              <span class="rk-badge ${i < 3 ? "r" + (i + 1) : ""}">${i + 1}</span>
              <span class="rk-name">${p.name}</span>
              <span class="rk-store">${p.tag || ""}</span>
              <span class="rk-bar"><i data-w="${((p.amount / max) * 100).toFixed(1)}" style="--c:${colorOf(p)}"></i></span>
              <span class="rk-val">${p.amount.toFixed(1)}<small>万</small></span>
            </div>`,
          )
          .join("");
        if (setW)
          $(containerId)
            .querySelectorAll("i[data-w]")
            .forEach((el) => (el.style.width = el.dataset.w + "%"));
      }
      renderRank("rowsConsult", MODEL.staff.consultants, false);
      renderRank("rowsDoctor", MODEL.staff.doctors, false);

      /* ══════════════════════════════════════════════════════════
       * ⑨ 底部折线：尺寸由容器反算，杜绝溢出
       * ══════════════════════════════════════════════════════════ */
      const bodyBox = document.querySelector(".trend-body");
      const TW = bodyBox.clientWidth,
        TH = bodyBox.clientHeight;
      const PAD_L = 52,
        PAD_R = 18,
        PAD_T = 8,
        PAD_B = 24;
      const PLOT_W = TW - PAD_L - PAD_R,
        PLOT_H = TH - PAD_T - PAD_B; // 128
      const trendSvg = $("trendSvg");
      trendSvg.setAttribute("viewBox", `0 0 ${TW} ${TH}`);
      const xAt = (i) => PAD_L + (i * PLOT_W) / (D - 1);
      let MAXV = Math.ceil((Math.max(...dailyAll) * 1.15) / 5) * 5; // 心跳后可能重算升档
      const yAt = (v) => PAD_T + (1 - v / MAXV) * PLOT_H;

      function drawGrid() {
        let html = "";
        [0.25, 0.5, 0.75, 1].forEach((k) => {
          const y = yAt(MAXV * k).toFixed(1);
          html += `<line class="grid-ln" x1="${PAD_L}" y1="${y}" x2="${TW - PAD_R}" y2="${y}" />`;
          html += `<text class="axis-txt" x="${PAD_L - 8}" y="${+y + 5}" text-anchor="end">${Math.round(MAXV * k)}</text>`;
        });
        [1, 5, 10, 15, 20, 25, 30].forEach((d) => {
          html += `<text class="axis-txt" x="${xAt(d - 1).toFixed(1)}" y="${TH - 6}" text-anchor="middle">9/${d}</text>`;
        });
        html += `<text class="axis-txt" x="${PAD_L - 8}" y="${yAt(MAXV) + 5}" text-anchor="end">万</text>`;
        $("tGrid").innerHTML = html;
      }
      drawGrid();

      const SERIES = {
        all: { name: "全部门店", color: "#f0cf7a", data: dailyAll },
      };
      STORES.forEach(
        (s) =>
          (SERIES[s.id] = {
            name: s.name,
            color: s.color,
            data: dailyByStore[s.id],
          }),
      );
      Object.values(SERIES).forEach((se) => {
        se.y = se.data.map((v) => yAt(v));
        se.cum = se.data.reduce(
          (acc, v) => (acc.push((acc[acc.length - 1] || 0) + v), acc),
          [],
        );
      });

      const lineEl = $("lgLine"),
        areaEl = $("lgArea"),
        pulseEl = $("lgPulse"),
        endDotEl = $("lgEndDot");
      let curKey = "all";
      function pathsOf(y) {
        const pts = y.map((yy, i) => `${xAt(i).toFixed(1)},${yy.toFixed(1)}`);
        const dLine = "M " + pts.join(" L ");
        const base = (PAD_T + PLOT_H).toFixed(1);
        return {
          dLine,
          dArea:
            dLine + ` L ${xAt(T - 1).toFixed(1)},${base} L ${PAD_L},${base} Z`,
        };
      }
      function paint(key, yOverride, colorOverride) {
        const se = SERIES[key],
          y = yOverride || se.y,
          color = colorOverride || se.color;
        const { dLine, dArea } = pathsOf(y);
        lineEl.setAttribute("d", dLine);
        areaEl.setAttribute("d", dArea);
        lineEl.setAttribute("stroke", color);
        $("tAreaA").setAttribute("stop-color", color);
        pulseEl.setAttribute("cx", xAt(T - 1));
        pulseEl.setAttribute("cy", y[T - 1]);
        pulseEl.setAttribute("stroke", color);
        endDotEl.setAttribute("cx", xAt(T - 1));
        endDotEl.setAttribute("cy", y[T - 1]);
      }
      function mixColor(h0, h1, t) {
        const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
        const a = p(h0),
          b = p(h1);
        return `rgb(${a.map((v, i) => Math.round(lerp(v, b[i], t))).join(",")})`;
      }
      paint(curKey);

      function switchSeries(key) {
        if (key === curKey || !SERIES[key]) return;
        const fromY = SERIES[curKey].y.slice(),
          fromC = SERIES[curKey].color;
        const toY = SERIES[key].y,
          toC = SERIES[key].color;
        curKey = key;
        $("selLabel").textContent = SERIES[key].name;
        $("lgName").textContent = SERIES[key].name;
        document
          .querySelectorAll("#selMenu li")
          .forEach((li) => li.classList.toggle("cur", li.dataset.key === key));
        const t0 = performance.now(),
          DUR = 260;
        (function frame(now) {
          const k = easeOut(clamp((now - t0) / DUR, 0, 1));
          paint(
            key,
            fromY.map((v, i) => lerp(v, toY[i], k)),
            mixColor(fromC, toC, k),
          );
          if (k < 1) requestAnimationFrame(frame);
          else paint(key);
        })(t0);
      }

      (function initSelect() {
        const sel = $("sel"),
          menu = $("selMenu");
        menu.innerHTML =
          `<li class="all cur" data-key="all"><span class="dot"></span>全部门店</li>` +
          STORES.map(
            (s) =>
              `<li data-key="${s.id}"><span class="dot" style="background:${s.color}"></span>${s.name}</li>`,
          ).join("");
        $("selBtn").addEventListener("click", (e) => {
          e.stopPropagation();
          sel.classList.toggle("open");
        });
        menu.addEventListener("click", (e) => {
          const li = e.target.closest("li");
          if (!li) return;
          switchSeries(li.dataset.key);
          sel.classList.remove("open");
        });
        document.addEventListener("click", () => sel.classList.remove("open"));
        document.addEventListener(
          "keydown",
          (e) => e.key === "Escape" && sel.classList.remove("open"),
        );
      })();

      (function initHover() {
        const pad = $("hoverPad"),
          tip = $("tip"),
          hLn = $("hoverLn"),
          hDot = $("hoverDot");
        pad.setAttribute("x", PAD_L);
        pad.setAttribute("y", PAD_T);
        pad.setAttribute("width", PLOT_W);
        pad.setAttribute("height", PLOT_H);
        trendSvg.addEventListener("mousemove", (e) => {
          const r = trendSvg.getBoundingClientRect();
          const mx = (e.clientX - r.left) / SCALE;
          const i = clamp(
            Math.round((mx - PAD_L) / (PLOT_W / (D - 1))),
            0,
            T - 1,
          );
          const se = SERIES[curKey],
            x = xAt(i),
            y = se.y[i];
          hLn.style.display = hDot.style.display = "";
          hLn.setAttribute("x1", x);
          hLn.setAttribute("x2", x);
          hLn.setAttribute("y1", PAD_T);
          hLn.setAttribute("y2", PAD_T + PLOT_H);
          hDot.setAttribute("cx", x);
          hDot.setAttribute("cy", y);
          hDot.setAttribute("stroke", se.color);
          tip.style.display = "block";
          tip.innerHTML = `9月${i + 1}日 · <b>${se.data[i].toFixed(1)}</b> 万<br>累计 <b>${se.cum[i].toFixed(1)}</b> 万 · ${se.name}`;
          const tw = tip.offsetWidth / SCALE;
          tip.style.left = x + (i > (D * 2) / 3 ? -tw - 16 : 16) + "px";
          tip.style.top = clamp(y - 30, 4, TH - 60) + "px";
        });
        trendSvg.addEventListener("mouseleave", () => {
          tip.style.display = "none";
          hLn.style.display = hDot.style.display = "none";
        });
      })();

      /* ══════════════════════════════════════════════════════════
       * ⑩ 入场编排 + KPI 数字滚动
       * ══════════════════════════════════════════════════════════ */
      (function entrance() {
        const setNumbers = (k) => {
          $("vTime").textContent = (KPI.timePct * k).toFixed(1);
          $("vRev").textContent = fmtW(totalRev * k);
          $("vInit").textContent = fmtI(totalInit * k);
          drawRT(KPI.timePct * k);
          drawRR(KPI.revPct * k);
          drawRI(KPI.initPct * k);
        };
        document
          .querySelectorAll(".rv")
          .forEach((el) => el.classList.add("in"));
        if (!ANIM) {
          document
            .querySelectorAll("i[data-w]")
            .forEach((el) => (el.style.width = el.dataset.w + "%"));
          setNumbers(1);
          return;
        }
        const rvs = document.querySelectorAll(".rv");
        document
          .querySelectorAll(".rv")
          .forEach((el) => el.classList.remove("in"));
        rvs.forEach((el, i) =>
          setTimeout(() => el.classList.add("in"), 120 + i * 80),
        );
        setTimeout(
          () =>
            document
              .querySelectorAll("i[data-w]")
              .forEach((el) => (el.style.width = el.dataset.w + "%")),
          650,
        );
        const t0 = performance.now(),
          DUR = 1800;
        (function frame(now) {
          const k = easeOut(clamp((now - t0) / DUR, 0, 1));
          setNumbers(k);
          if (k < 1) requestAnimationFrame(frame);
        })(t0);
      })();

      /* ══════════════════════════════════════════════════════════
       * ⑪ 时钟
       * ══════════════════════════════════════════════════════════ */
      (function clock() {
        const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
        const p = (n) => String(n).padStart(2, "0");
        (function tick() {
          const d = new Date();
          $("clkTime").textContent =
            `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
          $("clkDate").textContent =
            `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${WD[d.getDay()]}`;
          setTimeout(tick, 1000);
        })();
      })();

      /* ══════════════════════════════════════════════════════════
       * ⑫ 数据心跳：每 5 分钟重新抓取 BI 数据并全量刷新（页面不重载）
       * ══════════════════════════════════════════════════════════ */
      const ENTRANCE_END = performance.now() + (ANIM ? 2600 : 0);
      let dispY = SERIES[curKey].y.slice(); // 折线当前显示的 y（用于插值起点）
      let curArc = STORES.map((s) => s.revPct); // 6 段弧当前完成率
      let heroCur = KPI.revPct; // 水球当前水位
      let ringCur = { time: KPI.timePct, rev: KPI.revPct, init: KPI.initPct };
      const beatFade = (el) => {
        el.classList.remove("bfade");
        void el.offsetWidth;
        el.classList.add("bfade");
      };

      /* KPI 三卡：数字滚动 + 三只环同步补间 */
      function updateKPI(m, animate) {
        const setN = (id, to, fmt) => {
          const el = $(id);
          if (!animate) {
            el.textContent = fmt(to);
            return;
          }
          const from =
            parseFloat((el.textContent + "").replace(/[^\d.-]/g, "")) || 0;
          tweenNum(el, from, to, fmt);
        };
        setN("vTime", m.kpi.timePct, (v) => v.toFixed(1));
        setN("vRev", m.totalRev, fmtW);
        setN("vInit", m.totalInit, fmtI);
        $("subInit").textContent =
          `基础 ${fmtI(m.totalInitBase)} 人 · 客单 ${fmtI(m.kpi.avgTicket)} 元`;
        const to = {
          time: m.kpi.timePct,
          rev: m.kpi.revPct,
          init: m.kpi.initPct,
        };
        if (!animate) {
          drawRT(to.time);
          drawRR(to.rev);
          drawRI(to.init);
        } else {
          const from = ringCur,
            t0 = performance.now(),
            DUR = 900;
          (function f(now) {
            const k = easeOut(clamp((now - t0) / DUR, 0, 1));
            drawRT(lerp(from.time, to.time, k));
            drawRR(lerp(from.rev, to.rev, k));
            drawRI(lerp(from.init, to.init, k));
            if (k < 1) requestAnimationFrame(f);
          })(t0);
        }
        ringCur = to;
      }

      /* 中央 Hero：弧段生长 / 水位升降 / 主数字滚动 / 左右标签同步 */
      function updateHero(m, animate) {
        const target = m.kpi.revPct;
        fitHeroNumber(target.toFixed(1) + "%"); // 字号按终态适配，滚动中宽度稳定
        const fromArc = curArc.slice(),
          fromHero = heroCur;
        const apply = (k) => {
          m.stores.forEach((s, i) => {
            const p = lerp(fromArc[i], s.revPct, k);
            drawProgress(i, p);
            labels[i].querySelector(".pct").textContent = p.toFixed(1) + "%";
            labels[i].querySelector(".bar i").style.width =
              clamp(p, 0, 100) + "%";
          });
          const hp = lerp(fromHero, target, k);
          drawWaves(hp);
          hPct.textContent = hp.toFixed(1) + "%";
        };
        if (!animate) apply(1);
        else tween(950, apply);
        curArc = m.stores.map((s) => s.revPct);
        heroCur = target;
      }

      /* 底部折线：序列整体替换 + 260~700ms 插值；量程变档时重建网格 */
      function updateTrend(m, animate) {
        const newMax = Math.ceil((Math.max(...m.daily.all) * 1.15) / 5) * 5;
        const rescaled = newMax !== MAXV;
        MAXV = newMax;
        SERIES.all.data = m.daily.all;
        m.stores.forEach((s) => (SERIES[s.id].data = m.daily.byId[s.id]));
        Object.values(SERIES).forEach((se) => {
          se.y = se.data.map((v) => yAt(v));
          se.cum = se.data.reduce(
            (acc, v) => (acc.push((acc[acc.length - 1] || 0) + v), acc),
            [],
          );
        });
        if (rescaled) drawGrid();
        const toY = SERIES[curKey].y,
          fromY = dispY;
        dispY = toY.slice();
        if (!animate) {
          paint(curKey);
          return;
        }
        const t0 = performance.now(),
          DUR = 700;
        (function f(now) {
          const k = easeOut(clamp((now - t0) / DUR, 0, 1));
          paint(
            curKey,
            fromY.map((v, i) => lerp(v, toY[i], k)),
          );
          if (k < 1) requestAnimationFrame(f);
          else paint(curKey);
        })(t0);
      }

      /* 一次心跳 = 全板原地刷新 */
      function applyModel(m, animate) {
        updateKPI(m, animate);
        updateChannels(m);
        updateHero(m, animate);
        updateRevRows(m, animate);
        renderRevisitRows(m, true);
        beatFade($("rowsRevisit"));
        renderRank("rowsConsult", m.staff.consultants, true);
        beatFade($("rowsConsult"));
        renderRank("rowsDoctor", m.staff.doctors, true);
        beatFade($("rowsDoctor"));
        updateTrend(m, animate);
      }


      /* 节拍器：每 HB_MS 拍一次，入场动画结束后才开拍 */
      const hbBox = $("hbBox"),
        hbText = $("hbText");
      let nextAt = Date.now() + HB_MS,
        flashUntil = 0,
        lastSync = "",
        hbT = 0;
      setInterval(() => {
        if (performance.now() < ENTRANCE_END) return;
        loadDashboardData()
          .then((fresh) => {
            if (fresh.campaign.today !== T) {
              location.reload(); // 跨天：整页重载，时间轴按新天数重排
              return;
            }
            MODEL = fresh.model;
            applyModel(MODEL, true);
            setFoot(fresh.updatedAt);
          })
          .catch((e) => console.warn("数据心跳取数失败,保留当前数据", e));
        nextAt = Date.now() + HB_MS;
        lastSync = new Date().toTimeString().slice(0, 8);
        flashUntil = Date.now() + 3200;
        hbBox.classList.remove("flash");
        void hbBox.offsetWidth;
        hbBox.classList.add("flash");
        clearTimeout(hbT);
        hbT = setTimeout(() => hbBox.classList.remove("flash"), 1200);
      }, HB_MS);

      /* 指示器文案：刷新后 3.2s 显示「已同步」，平时显示倒计时 */
      setInterval(() => {
        if (Date.now() < flashUntil) {
          hbText.textContent = `已同步数据 · ${lastSync}`;
          return;
        }
        const left = Math.max(0, nextAt - Date.now());
        hbText.textContent = ` 下次自动刷新时间 ${p2(Math.floor(left / 60000))}:${p2(Math.floor((left % 60000) / 1000))}`;
      }, 500);
