"use strict";

const $ = (s) => document.querySelector(s);
const STORAGE_KEY = "decision-desk-session";

let state = null;
let busy = false;
let selectedPair = null; // 冲突环上待重新判定的组合 {a, b}
let focusPair = null; // 跳转到推荐组合后的当前评审组合 {a, b}，null 表示按原顺序
let selectedCandidates = []; // 「排名依据」面板中已选择的候选项（至多 2 个，按选择顺序）
let basisData = null; // 当前选择对应的双向最强路径解释（含 error 字段时为请求失败）
let basisKey = null; // basisData 对应的去重键（含状态代次），null 表示尚无数据/未在请求
let basisReqId = 0; // 请求序号，丢弃过期响应
let stateEpoch = 0; // 每次拿到新状态自增，用于判定排名依据是否需要随状态刷新

/* ---------- 工具 ---------- */

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 2800);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    let detail = `请求失败（${res.status}）`;
    try {
      const body = await res.json();
      if (body.detail) detail = body.detail;
    } catch (_) { /* 忽略非 JSON 响应 */ }
    throw new Error(detail);
  }
  return res.json();
}

function setState(next) {
  state = next;
  stateEpoch += 1; // 新状态到达：排名依据面板需要按最新判断重新请求
}

/* ---------- 视图 ---------- */

function showSetup() {
  $("#setup-view").classList.remove("hidden");
  $("#review-view").classList.add("hidden");
}

function render() {
  $("#setup-view").classList.add("hidden");
  $("#review-view").classList.remove("hidden");

  const { done, total } = state.progress;
  $("#progress-bar").style.width = total ? `${(done / total) * 100}%` : "0%";
  $("#progress-text").textContent = `${done} / ${total}`;

  // 跳转组合已不在待比较列表（已判定/撤销/重置）时自动回到原顺序
  if (focusPair && !state.pending.some((p) => p.a === focusPair.a && p.b === focusPair.b)) {
    focusPair = null;
  }
  const active = focusPair || state.current_pair;
  $("#current-pair").classList.toggle("hidden", !active);
  $("#done-banner").classList.toggle("hidden", !!active);
  if (active) {
    $("#btn-a").textContent = active.a;
    $("#btn-b").textContent = active.b;
  }
  $("#jump-banner").classList.toggle("hidden", !focusPair);
  if (focusPair && state.current_pair) {
    $("#jump-original").textContent = `${state.current_pair.a} ↔ ${state.current_pair.b}`;
  }
  $("#undo-btn").disabled = !state.can_undo;

  // 候选项集合变化（新一轮/刷新到别的会话）时清掉失效选择
  if (selectedCandidates.some((name) => !state.candidates.includes(name))) {
    selectedCandidates = [];
    basisData = null;
    basisKey = null;
  }

  renderRanking();
  renderPending();
  renderMatrix();
  renderConflict();
  renderNextPair();
  syncBasis();
}

function renderRanking() {
  renderRankingInto($("#ranking"), state.ranking, true);
}

function renderPending() {
  const box = $("#pending-list");
  box.innerHTML = "";
  if (state.pending.length === 0) {
    const span = document.createElement("span");
    span.className = "empty";
    span.textContent = "✓ 全部组合均已比较";
    box.appendChild(span);
    return;
  }
  for (const p of state.pending) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = `${p.a} ↔ ${p.b}`;
    box.appendChild(chip);
  }
}

const SYMBOLS = { win: "✓", lose: "✗", tie: "＝", pending: "·", self: "—" };

function conflictCells() {
  // 冲突环上每个组合对应的两个矩阵格（i:j 与 j:i）
  const cells = new Set();
  if (state.conflict) {
    const pos = new Map(state.candidates.map((name, i) => [name, i]));
    for (const e of state.conflict.edges) {
      const i = pos.get(e.a);
      const j = pos.get(e.b);
      cells.add(`${i}:${j}`).add(`${j}:${i}`);
    }
  }
  return cells;
}

function suggestionCells() {
  // 最少改判方案中各组合对应的两个矩阵格
  const cells = new Set();
  if (state.suggestion) {
    const pos = new Map(state.candidates.map((name, i) => [name, i]));
    for (const p of state.suggestion.pairs) {
      const i = pos.get(p.a);
      const j = pos.get(p.b);
      cells.add(`${i}:${j}`).add(`${j}:${i}`);
    }
  }
  return cells;
}

function basisCells() {
  // 双向最强路径上的每条边对应的矩阵格，区分方向：
  // i→j 边标记 (i,j) 格为「行 → 列」方向；另一格标反向。
  const cells = new Map(); // "i:j" -> "fwd" | "back"
  const mark = (list, cls) => {
    if (!list) return;
    const pos = new Map(state.candidates.map((name, i) => [name, i]));
    for (const e of list) {
      cells.set(`${pos.get(e.from)}:${pos.get(e.to)}`, cls);
    }
  };
  if (basisData && !basisData.error) {
    mark(basisData.forward.edges, "fwd");
    mark(basisData.backward.edges, "back");
  }
  return cells;
}

function renderMatrix() {
  const wrap = $("#matrix-wrap");
  wrap.innerHTML = "";
  const conflicts = conflictCells();
  const suggested = suggestionCells();
  const paths = basisCells();
  const table = document.createElement("table");
  table.className = "matrix";

  const headRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.textContent = "";
  headRow.appendChild(corner);
  for (const name of state.candidates) {
    const th = document.createElement("th");
    th.textContent = name;
    th.title = `${name}（点击加入「排名依据」选择）`;
    th.classList.add("selectable-th");
    if (selectedCandidates.includes(name)) th.classList.add("th-selected");
    th.addEventListener("click", () => toggleBasisCandidate(name));
    headRow.appendChild(th);
  }
  const thead = document.createElement("thead");
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  state.matrix.forEach((cells, i) => {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = state.candidates[i];
    th.title = `${state.candidates[i]}（点击加入「排名依据」选择）`;
    th.classList.add("selectable-th");
    if (selectedCandidates.includes(state.candidates[i])) th.classList.add("th-selected");
    th.addEventListener("click", () => toggleBasisCandidate(state.candidates[i]));
    tr.appendChild(th);
    cells.forEach((cell, j) => {
      const td = document.createElement("td");
      td.className = `cell-${cell}`;
      td.textContent = SYMBOLS[cell];
      const key = `${i}:${j}`;
      if (conflicts.has(key)) {
        td.classList.add("cell-conflict");
        td.title = "循环冲突组合，点击重新判定";
        td.addEventListener("click", () => {
          selectConflictPair({
            a: state.candidates[Math.min(i, j)],
            b: state.candidates[Math.max(i, j)],
          });
        });
      } else if (suggested.has(key)) {
        td.classList.add("cell-suggestion");
        td.title = "最少改判方案：点击可手动重新判定";
        td.addEventListener("click", () => {
          selectConflictPair({
            a: state.candidates[Math.min(i, j)],
            b: state.candidates[Math.max(i, j)],
          });
        });
      } else {
        // 普通格：行、列两个候选项直接作为「排名依据」的一对
        if (i !== j) {
          td.classList.add("selectable-cell");
          td.title = "点击在「排名依据」中比较这两个候选项";
          td.addEventListener("click", () => {
            pickBasisPair(state.candidates[i], state.candidates[j]);
          });
        }
      }
      const dir = paths.get(key);
      if (dir === "fwd") td.classList.add("cell-path-fwd");
      else if (dir === "back") td.classList.add("cell-path-back");
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
}

/* ---------- 循环冲突复核 ---------- */

function renderConflict() {
  const card = $("#conflict-card");
  const conflict = state.conflict;
  if (!conflict) {
    selectedPair = null;
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  $("#conflict-path").textContent = [...conflict.cycle, conflict.cycle[0]].join(" → ");

  // 选中组合已不在当前环上、也不在改判建议中（如经撤销/重判）时收起面板
  if (
    selectedPair &&
    !conflict.edges.some((e) => e.a === selectedPair.a && e.b === selectedPair.b) &&
    !(state.suggestion &&
      state.suggestion.pairs.some((p) => p.a === selectedPair.a && p.b === selectedPair.b))
  ) {
    selectedPair = null;
  }

  const box = $("#conflict-pairs");
  box.innerHTML = "";
  for (const e of conflict.edges) {
    const chip = document.createElement("button");
    const winner = e.result === "a" ? e.a : e.b;
    const loser = e.result === "a" ? e.b : e.a;
    chip.className =
      "chip conflict-chip" +
      (selectedPair && selectedPair.a === e.a && selectedPair.b === e.b ? " selected" : "");
    chip.textContent = `${winner} 胜 ${loser}`;
    chip.title = "点击重新判定该组合";
    chip.addEventListener("click", () => selectConflictPair(e));
    box.appendChild(chip);
  }

  const panel = $("#revise-panel");
  panel.classList.toggle("hidden", !selectedPair);
  if (selectedPair) {
    $("#revise-title").textContent = `重新判定：${selectedPair.a} ↔ ${selectedPair.b}`;
    $("#revise-a").textContent = `「${selectedPair.a}」胜`;
    $("#revise-b").textContent = `「${selectedPair.b}」胜`;
  }

  renderSuggestion();
}

function renderRankingInto(box, groups, selectable = false) {
  box.innerHTML = "";
  let rank = 1; // 竞争排名：并列后跳名次
  for (const group of groups) {
    const row = document.createElement("div");
    row.className = "rank-row" + (group.length > 1 ? " tied" : "");
    const badge = document.createElement("span");
    badge.className = "rank-badge";
    badge.textContent = `第 ${rank} 名`;
    const names = document.createElement("span");
    names.className = "rank-names";
    group.forEach((name, gi) => {
      if (gi > 0) names.appendChild(document.createTextNode(" ＝ "));
      if (selectable) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className =
          "rank-name" + (selectedCandidates.includes(name) ? " selected" : "");
        btn.textContent = name;
        btn.title = "加入/移出「排名依据」选择";
        btn.addEventListener("click", () => toggleBasisCandidate(name));
        names.appendChild(btn);
      } else {
        names.appendChild(document.createTextNode(name));
      }
    });
    row.append(badge, names);
    box.appendChild(row);
    rank += group.length;
  }
}

function renderSuggestion() {
  const panel = $("#suggestion-panel");
  const s = state.suggestion;
  if (!s) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  $("#suggestion-count").textContent = `共 ${s.change_count} 个组合`;
  $("#suggestion-num").textContent = s.change_count;

  const box = $("#suggestion-pairs");
  box.innerHTML = "";
  for (const p of s.pairs) {
    const chip = document.createElement("button");
    chip.className =
      "chip suggestion-chip" +
      (selectedPair && selectedPair.a === p.a && selectedPair.b === p.b ? " selected" : "");
    chip.textContent = `${p.a} ＝ ${p.b}`;
    chip.title = "点击可手动重新判定该组合";
    chip.addEventListener("click", () => selectConflictPair(p));
    box.appendChild(chip);
  }

  const affected = $("#suggestion-affected");
  affected.innerHTML = "";
  for (const item of s.affected) {
    const row = document.createElement("div");
    row.className = "affected-row";
    const winner = item.from === "a" ? item.a : item.b;
    const loser = item.from === "a" ? item.b : item.a;
    row.innerHTML =
      `<span class="affected-from">${winner} 胜 ${loser}</span>` +
      `<span class="affected-arrow">→</span>` +
      `<span class="affected-to">${item.a} ＝ ${item.b}（平局）</span>`;
    affected.appendChild(row);
  }

  renderRankingInto($("#suggestion-ranking"), s.preview_ranking);
}

function selectConflictPair(pair) {
  selectedPair = { a: pair.a, b: pair.b };
  renderConflict();
  $("#conflict-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ---------- 排名依据：双向最强路径 ---------- */

function toggleBasisCandidate(name) {
  const at = selectedCandidates.indexOf(name);
  if (at >= 0) {
    selectedCandidates.splice(at, 1); // 再次点击取消
  } else if (selectedCandidates.length < 2) {
    selectedCandidates.push(name);
  } else {
    // 已选两个：最早的选择让位，保留最近一次选择的上下文
    selectedCandidates = [selectedCandidates[1], name];
  }
  basisData = null;
  basisKey = null;
  renderRanking();
  renderMatrix();
  syncBasis();
}

function pickBasisPair(a, b) {
  selectedCandidates = [a, b];
  basisData = null;
  basisKey = null;
  renderRanking();
  renderMatrix();
  syncBasis();
  $("#basis-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function strengthText(v) {
  if (v >= 1) return "1.0（严格胜负）";
  if (v >= 0.5) return "0.5（平局）";
  return "0（无有效路径）";
}

function renderDirectionBox(box, title, dir) {
  box.innerHTML = "";
  const head = document.createElement("p");
  head.className = "basis-dir-head";
  head.textContent = title;
  box.appendChild(head);

  if (!dir.path) {
    const none = document.createElement("div");
    none.className = "basis-no-path";
    none.textContent = "无有效路径（强度 0）";
    box.appendChild(none);
    return;
  }

  const meta = document.createElement("p");
  meta.className = "basis-meta";
  meta.textContent =
    `瓶颈强度 ${dir.strength}（${dir.strength >= 1 ? "严格胜负" : "平局"}）` +
    ` · 共 ${dir.hops} 条边（${dir.path.length} 个候选项，不重复节点）`;
  box.appendChild(meta);

  const flow = document.createElement("div");
  flow.className = "basis-flow";
  dir.edges.forEach((e, ei) => {
    if (ei > 0) {
      const gap = document.createElement("span");
      gap.className = "basis-flow-gap";
      gap.textContent = " · ";
      flow.appendChild(gap);
    }
    const node = document.createElement("span");
    node.className = "basis-node";
    node.textContent = e.from;
    flow.appendChild(node);
    const arrow = document.createElement("span");
    const bottleneck = e.strength === dir.strength;
    arrow.className = "basis-arrow" + (bottleneck ? " bottleneck" : "");
    arrow.textContent = e.strength >= 1 ? " 胜 " : " 平 ";
    arrow.title = `该边强度 ${e.strength}${bottleneck ? "（本路径瓶颈）" : ""}`;
    flow.appendChild(arrow);
    if (ei === dir.edges.length - 1) {
      const end = document.createElement("span");
      end.className = "basis-node";
      end.textContent = e.to;
      flow.appendChild(end);
    }
  });
  box.appendChild(flow);
}

function renderBasis() {
  const pickText = $("#basis-pick-text");
  const clearBtn = $("#basis-clear");
  const result = $("#basis-result");
  result.innerHTML = "";

  const n = selectedCandidates.length;
  if (n === 0) {
    pickText.textContent = "尚未选择候选项（还差 2 个）";
  } else if (n === 1) {
    pickText.innerHTML = "";
    pickText.appendChild(document.createTextNode("已选 1 项："));
    const tag = document.createElement("span");
    tag.className = "basis-pick-tag";
    tag.textContent = selectedCandidates[0];
    pickText.appendChild(tag);
    pickText.appendChild(document.createTextNode("，再选 1 项"));
  } else {
    pickText.innerHTML = "";
    pickText.appendChild(document.createTextNode("正在比较："));
    selectedCandidates.forEach((name, i) => {
      if (i > 0) pickText.appendChild(document.createTextNode(" ↔ "));
      const tag = document.createElement("span");
      tag.className = "basis-pick-tag";
      tag.textContent = name;
      pickText.appendChild(tag);
    });
  }
  clearBtn.classList.toggle("hidden", n === 0);

  if (n < 2) return;

  if (!basisData) {
    const loading = document.createElement("p");
    loading.className = "muted basis-loading";
    loading.textContent = "正在重建最强路径…";
    result.appendChild(loading);
    return;
  }

  if (basisData.error) {
    const err = document.createElement("p");
    err.className = "basis-error";
    err.textContent = `排名依据加载失败：${basisData.error}`;
    result.appendChild(err);
    return;
  }

  const { a, b, verdict, forward, backward } = basisData;
  const banner = document.createElement("div");
  banner.className = "basis-verdict verdict-" + verdict;
  if (verdict === "a") {
    banner.innerHTML =
      `<strong>${a}</strong> 领先于 <strong>${b}</strong>` +
      `（${strengthText(forward.strength).split("（")[0]} &gt; ${backward.strength}）`;
  } else if (verdict === "b") {
    banner.innerHTML =
      `<strong>${a}</strong> 落后于 <strong>${b}</strong>` +
      `（${forward.strength} &lt; ${strengthText(backward.strength).split("（")[0]}）`;
  } else {
    banner.innerHTML =
      `<strong>${a}</strong> 与 <strong>${b}</strong> <strong>并列</strong>` +
      `（双向最强路径强度均为 ${forward.strength}）`;
  }
  result.appendChild(banner);

  const fwdBox = document.createElement("div");
  fwdBox.className = "basis-dir";
  const backBox = document.createElement("div");
  backBox.className = "basis-dir";
  renderDirectionBox(fwdBox, `${a} → ${b}（判定前者是否领先后者）`, forward);
  renderDirectionBox(backBox, `${b} → ${a}（反方向）`, backward);
  result.append(fwdBox, backBox);

  const note = document.createElement("p");
  note.className = "muted basis-note";
  note.textContent =
    "判定规则：比较双向最强路径的瓶颈强度（路径上最弱一环），强度大者领先，相等则并列；" +
    "同强度路径优先边数更少者，再按候选录入顺序稳定选择。新增判断、撤销、复核或批量改判后，本面板随状态自动刷新。";
  result.appendChild(note);
}

async function syncBasis() {
  if (!state) return;
  renderBasis();
  if (selectedCandidates.length !== 2) {
    basisData = null;
    basisKey = null;
    return;
  }
  const [a, b] = selectedCandidates;
  const key = `${state.session_id}|${stateEpoch}|${a}|${b}`;
  if (key === basisKey) return; // 同一状态下已加载或正在请求，避免重复调用
  basisKey = key;
  basisData = null; // 立即清除上一状态的路径，避免矩阵残留旧高亮
  renderBasis();
  renderMatrix();
  const reqId = ++basisReqId;
  try {
    const url =
      `/api/sessions/${encodeURIComponent(state.session_id)}/ranking-basis` +
      `?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`;
    const data = await api(url);
    if (reqId !== basisReqId || key !== basisKey) return; // 已被更新的选择/状态取代
    basisData = data;
  } catch (e) {
    if (reqId !== basisReqId || key !== basisKey) return;
    basisData = { error: e.message };
  }
  renderBasis();
  renderMatrix(); // 路径边高亮依赖 basisData
}

/* ---------- 下一对推荐 ---------- */

function renderNextPair() {
  const card = $("#nextpair-card");
  const np = state.next_pair;
  if (!np) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  $("#nextpair-name").textContent = `${np.a} ↔ ${np.b}`;
  if (np.impact > 0) {
    $("#nextpair-reason").textContent =
      `三种结果下共有 ${np.impact} / ${np.candidate_pairs} 个候选对的相对名次` +
      `（前 / 后 / 并列）会发生变化，为当前所有待比较组合中影响最大；` +
      `影响分相同的组合按原待比较顺序推荐。`;
  } else {
    $("#nextpair-reason").textContent =
      "当前所有待比较组合的结果都不会再改变任何候选对的相对名次，可按原顺序完成剩余比较。";
  }
  $("#nextpair-title-a").textContent = `若「${np.a}」胜`;
  $("#nextpair-title-b").textContent = `若「${np.b}」胜`;
  renderRankingInto($("#nextpair-rank-a"), np.previews.a);
  renderRankingInto($("#nextpair-rank-tie"), np.previews.tie);
  renderRankingInto($("#nextpair-rank-b"), np.previews.b);

  const cur = state.current_pair;
  const isCurrent = cur && cur.a === np.a && cur.b === np.b;
  $("#nextpair-jump").classList.toggle("hidden", !!isCurrent);
  $("#nextpair-is-current").classList.toggle("hidden", !isCurrent);
}

function jumpToRecommended() {
  if (busy || !state || !state.next_pair) return;
  focusPair = { a: state.next_pair.a, b: state.next_pair.b };
  render();
  $("#current-pair").scrollIntoView({ behavior: "smooth", block: "center" });
}

/* ---------- 数据操作 ---------- */

async function refresh() {
  const sid = localStorage.getItem(STORAGE_KEY);
  if (!sid) {
    showSetup();
    return;
  }
  try {
    setState(await api(`/api/sessions/${sid}`));
    render();
  } catch (_) {
    localStorage.removeItem(STORAGE_KEY);
    showSetup();
  }
}

async function judge(result) {
  if (busy || !state) return;
  const active = focusPair || state.current_pair;
  if (!active) return;
  busy = true;
  try {
    const { a, b } = active;
    setState(await api(`/api/sessions/${state.session_id}/judgments`, {
      method: "POST",
      body: JSON.stringify({ a, b, result }),
    }));
    focusPair = null; // 判定完成后回到原顺序流程
    render();
  } catch (e) {
    toast(e.message);
    await refresh();
  } finally {
    busy = false;
  }
}

async function undo() {
  if (busy || !state) return;
  busy = true;
  try {
    setState(await api(`/api/sessions/${state.session_id}/undo`, { method: "POST" }));
    render();
  } catch (e) {
    toast(e.message);
  } finally {
    busy = false;
  }
}

async function revise(result) {
  if (busy || !state || !selectedPair) return;
  busy = true;
  try {
    setState(await api(`/api/sessions/${state.session_id}/judgments`, {
      method: "PUT",
      body: JSON.stringify({ a: selectedPair.a, b: selectedPair.b, result }),
    }));
    selectedPair = null;
    render();
    toast("判定已更新，排名与冲突已重算");
  } catch (e) {
    toast(e.message);
    await refresh();
  } finally {
    busy = false;
  }
}

async function applySuggestion() {
  if (busy || !state || !state.suggestion) return;
  const n = state.suggestion.change_count;
  if (!confirm(`确认把这 ${n} 个组合批量改为平局吗？\n进度与撤销顺序保持不变，排名与冲突将立即重算。`)) {
    return;
  }
  busy = true;
  $("#suggestion-apply").disabled = true;
  try {
    setState(await api(`/api/sessions/${state.session_id}/resolve-conflicts`, {
      method: "POST",
      body: JSON.stringify({
        pairs: state.suggestion.pairs.map((p) => ({ a: p.a, b: p.b })),
      }),
    }));
    selectedPair = null;
    render();
    toast(state.conflict ? "已应用方案，仍存在其他循环冲突" : "已批量改判，全部循环冲突已消除");
  } catch (e) {
    toast(e.message);
    await refresh();
  } finally {
    busy = false;
  }
}

async function resetRound() {  if (busy || !state) return;
  if (!confirm("确定要清空本轮全部判断记录吗？")) return;
  busy = true;
  try {
    setState(await api(`/api/sessions/${state.session_id}/reset`, { method: "POST" }));
    focusPair = null;
    render();
    toast("本轮已重置");
  } catch (e) {
    toast(e.message);
  } finally {
    busy = false;
  }
}

async function startSession() {
  const names = $("#candidates-input").value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length < 3 || names.length > 12) {
    toast("请输入 3～12 个候选项（每行一个）");
    return;
  }
  if (new Set(names).size !== names.length) {
    toast("候选项名称不可重复");
    return;
  }
  try {
    setState(await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ candidates: names }),
    }));
    localStorage.setItem(STORAGE_KEY, state.session_id);
    selectedPair = null;
    focusPair = null;
    selectedCandidates = [];
    basisData = null;
    basisKey = null;
    render();
  } catch (e) {
    toast(e.message);
  }
}

function newRound() {
  if (!confirm("开始新一轮评审？当前进度将从本浏览器中移除（服务器记录仍保留）。")) return;
  localStorage.removeItem(STORAGE_KEY);
  state = null;
  selectedPair = null;
  focusPair = null;
  selectedCandidates = [];
  basisData = null;
  basisKey = null;
  showSetup();
}

/* ---------- 事件绑定 ---------- */

function updateCount() {
  const n = $("#candidates-input").value.split("\n").map((s) => s.trim()).filter(Boolean).length;
  $("#setup-count").textContent = n ? `已录入 ${n} 项` : "";
}

$("#candidates-input").addEventListener("input", updateCount);
$("#start-btn").addEventListener("click", startSession);
$("#btn-a").addEventListener("click", () => judge("a"));
$("#btn-b").addEventListener("click", () => judge("b"));
$("#btn-tie").addEventListener("click", () => judge("tie"));
$("#undo-btn").addEventListener("click", undo);
$("#reset-btn").addEventListener("click", resetRound);
$("#new-btn").addEventListener("click", newRound);
$("#revise-a").addEventListener("click", () => revise("a"));
$("#revise-tie").addEventListener("click", () => revise("tie"));
$("#revise-b").addEventListener("click", () => revise("b"));
$("#revise-cancel").addEventListener("click", () => {
  selectedPair = null;
  renderConflict();
});
$("#suggestion-apply").addEventListener("click", applySuggestion);
$("#nextpair-jump").addEventListener("click", jumpToRecommended);
$("#basis-clear").addEventListener("click", () => {
  selectedCandidates = [];
  basisData = null;
  basisKey = null;
  renderRanking();
  renderMatrix();
  syncBasis();
});
$("#jump-back").addEventListener("click", () => {
  focusPair = null;
  render();
});

document.addEventListener("keydown", (e) => {
  if ($("#review-view").classList.contains("hidden")) return;
  if (e.ctrlKey && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
    return;
  }
  if (!state || (!state.current_pair && !focusPair)) return;
  if (e.key === "ArrowLeft") judge("a");
  else if (e.key === "ArrowRight") judge("b");
  else if (e.key === "ArrowDown") judge("tie");
});

/* ---------- 启动 ---------- */

refresh();
