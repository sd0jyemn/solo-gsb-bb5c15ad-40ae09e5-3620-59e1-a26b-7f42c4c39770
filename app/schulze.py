"""Schulze 最强路径法（Strongest Path / Beatpath）排名计算。

计票约定：
- 甲胜乙：d(甲, 乙) = 1.0，d(乙, 甲) = 0
- 平局：  d(甲, 乙) = d(乙, 甲) = 0.5
- 未比较：双向均为 0

路径强度 = 路径上最弱一环的强度；最强路径取所有路径中的最大值。
候选项 i 严格优于 j 当且仅当 p[i][j] > p[j][i]，相等则并列。
"""
from __future__ import annotations

from collections import deque


def _direct_matrix(candidates: list[str], judgments: list[dict]) -> list[list[float]]:
    """由判断记录构建直接比较强度矩阵 d（平局双向 0.5，其余为 0）。"""
    n = len(candidates)
    idx = {name: i for i, name in enumerate(candidates)}
    d = [[0.0] * n for _ in range(n)]
    for j in judgments:
        a, b, result = idx[j["a"]], idx[j["b"]], j["result"]
        if result == "a":
            d[a][b] = 1.0
        elif result == "b":
            d[b][a] = 1.0
        else:  # tie
            d[a][b] = d[b][a] = 0.5
    return d


def _relax(p: list[list[float]]) -> None:
    """Floyd–Warshall 变体（原地）：p[i][j] = max(p[i][j], min(p[i][k], p[k][j]))。"""
    n = len(p)
    for k in range(n):
        for i in range(n):
            if i == k:
                continue
            pik = p[i][k]
            if pik == 0:
                continue
            row_i, row_k = p[i], p[k]
            for j in range(n):
                weakest = pik if pik < row_k[j] else row_k[j]
                if row_i[j] < weakest:
                    row_i[j] = weakest


def strongest_paths(candidates: list[str], judgments: list[dict]) -> list[list[float]]:
    """根据已记录的胜负关系计算最强路径强度矩阵 p。"""
    p = _direct_matrix(candidates, judgments)
    _relax(p)
    return p


def rank_groups(candidates: list[str], p: list[list[float]]) -> list[list[str]]:
    """按 Schulze 关系把候选项分成有序的并列组（名次最优的组在前）。"""
    n = len(candidates)
    wins = [sum(1 for j in range(n) if j != i and p[i][j] > p[j][i]) for i in range(n)]
    order = sorted(range(n), key=lambda i: -wins[i])
    groups: list[list[int]] = []
    for i in order:
        # Schulze 关系是全预序：与组内任一成员并列即与全组并列
        if groups and all(p[i][m] == p[m][i] for m in groups[-1]):
            groups[-1].append(i)
        else:
            groups.append([i])
    return [[candidates[i] for i in group] for group in groups]


# ---------- 最强路径重建（排名依据） ----------

def _bfs_dist(adj: list[list[int]], src: int) -> list[int]:
    """无权有向图上 src 到各点的最短边数，不可达为 -1。"""
    dist = [-1] * len(adj)
    dist[src] = 0
    q = deque([src])
    while q:
        u = q.popleft()
        for v in adj[u]:
            if dist[v] == -1:
                dist[v] = dist[u] + 1
                q.append(v)
    return dist


def _reconstruct_strongest_path(
    d: list[list[float]], p: list[list[float]], src: int, dst: int
) -> tuple[float, list[int]] | None:
    """在现有 Schulze 计算结果 p 之上重建一条 src → dst 的最强路径。

    选择规则（逐级稳定）：
    1. 路径瓶颈强度最大——必须等于 p[src][dst]（Floyd–Warshall 已求得的值）；
    2. 同强度路径中边数（节点数）最少；
    3. 仍相同时按候选录入顺序取节点下标序列字典序最小者；
    4. 路径为简单路径，不重复经过任何节点。

    做法：只保留强度 ≥ 目标瓶颈 w 的直接边构成子图，其最短路径即
    「瓶颈恰为 w 且边数最少」的路径；再逐位贪心选取最小可续接节点，
    得到字典序最小者。无路径（w == 0）时返回 None。
    """
    w = p[src][dst]
    if w <= 0:
        return None
    n = len(d)
    # 可行边子图：仅强度 ≥ w 的直接比较边（src→dst 自身可达由 p 值保证）
    adj = [
        [v for v in range(n) if v != u and d[u][v] >= w]
        for u in range(n)
    ]
    # 最少边数
    dist = _bfs_dist(adj, src)
    hops = dist[dst]
    if hops < 0:
        return None  # 理论上不会发生：p[src][dst] > 0 时必然存在可行路径

    # 各点到 dst 的最短边数：在反向图上从 dst 做一次 BFS 即可
    rev: list[list[int]] = [[] for _ in range(n)]
    for u in range(n):
        for v in adj[u]:
            rev[v].append(u)
    to_dst = _bfs_dist(rev, dst)

    # 逐位贪心：每一步在剩余预算内选录入序最小、且仍能按时到达 dst 的节点
    path = [src]
    used = {src}
    for _ in range(hops):
        u = path[-1]
        remaining = hops - (len(path) - 1)
        for v in adj[u]:  # adj[u] 已按节点下标升序
            if v not in used and to_dst[v] == remaining - 1:
                path.append(v)
                used.add(v)
                break
        else:  # pragma: no cover - 与 Floyd–Warshall 结果矛盾时的防御分支
            return None
    return w, path


def explain_pair(
    candidates: list[str], judgments: list[dict], name_a: str, name_b: str
) -> dict:
    """为两个候选项重建双向最强路径并给出领先 / 落后 / 并列判定。

    路径直接在当前 Schulze 计算使用的同一份直接比较矩阵上重建，
    每条路径附各边强度，瓶颈强度必须等于最强路径矩阵中的对应值，
    可由调用方逐条核验。无路径一方的 path 为 None、strength 为 0。
    """
    idx = {name: i for i, name in enumerate(candidates)}
    i, j = idx[name_a], idx[name_b]
    direct = _direct_matrix(candidates, judgments)
    p = [row[:] for row in direct]
    _relax(p)  # 复用同一 Floyd-Warshall 过程：p 即最强路径强度矩阵

    def one_way(src: int, dst: int) -> dict:
        found = _reconstruct_strongest_path(direct, p, src, dst)
        if found is None:
            return {"strength": 0.0, "hops": 0, "path": None, "edges": []}
        strength, nodes = found
        edges = [
            {
                "from": candidates[u],
                "to": candidates[v],
                "strength": direct[u][v],
            }
            for u, v in zip(nodes, nodes[1:])
        ]
        return {
            "strength": strength,
            "hops": len(edges),
            "path": [candidates[v] for v in nodes],
            "edges": edges,
        }

    ab = one_way(i, j)
    ba = one_way(j, i)
    if ab["strength"] > ba["strength"]:
        verdict = "a"
    elif ab["strength"] < ba["strength"]:
        verdict = "b"
    else:
        verdict = "tie"
    return {
        "a": name_a,
        "b": name_b,
        "verdict": verdict,  # 相对请求顺序：a 领先 / b 领先 / tie 并列
        "forward": ab,
        "backward": ba,
    }
