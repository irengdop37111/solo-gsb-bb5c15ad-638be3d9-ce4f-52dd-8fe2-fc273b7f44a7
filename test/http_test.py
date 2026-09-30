#!/usr/bin/env python3
"""HTTP 端到端集成测试。用法：先启动服务器于 127.0.0.1:3100，再运行本脚本。"""
import json
import urllib.request
import urllib.error

B = "http://127.0.0.1:3100"
PASS = FAIL = 0


def req(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(B + path, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)


def check(desc, expected, actual):
    global PASS, FAIL
    if expected == actual:
        PASS += 1
        print(f"  ✓ {desc}")
    else:
        FAIL += 1
        print(f"  ✗ {desc}\n      期望 {expected!r}\n      实际 {actual!r}")


def new_draft(name):
    _, d = req("POST", "/api/drafts", {"name": name})
    return d["draftId"]


# A. 首版
print("A. 首版初始化")
s, d = req("POST", "/api/initialize", {"note": "成立大会", "clauses": [
    {"cid": "a", "title": "总则", "body": "A", "refs": ["b"]},
    {"cid": "b", "title": "成员", "body": "B", "refs": []},
    {"cid": "c", "title": "义务", "body": "C", "refs": ["a", "b"]},
    {"cid": "d", "title": "附则", "body": "D", "refs": []},
]})
check("初始化返回 201", 201, s)
s, ov = req("GET", "/api/overview")
check("initialized=true", True, ov["initialized"])

# B. 并行不相交重放
print("B. 并行草案：D1 改 a、D2 改 c")
d1, d2 = new_draft("D1"), new_draft("D2")
req("PUT", f"/api/drafts/{d1}/clauses/a", {"body": "A2"})
req("PUT", f"/api/drafts/{d2}/clauses/c", {"body": "C2"})
s, d = req("POST", f"/api/drafts/{d1}/publish", {})
check("D1 发布 201", 201, s)
s, chk = req("GET", f"/api/drafts/{d2}/publish-check")
check("D2 预检通过", True, chk["ok"])
s, d = req("POST", f"/api/drafts/{d2}/publish", {})
check("D2 发布 201", 201, s)
check("D2 发生重放", True, d["replayed"])
s, v3 = req("GET", "/api/versions/3")
m = {c["cid"]: c for c in v3["clauses"]}
check("v3.a 保留对方改动", "A2", m["a"]["body"])
check("v3.c 重放本方改动", "C2", m["c"]["body"])
check("v3 引用完整", ["a", "b"], m["c"]["refs"])

# C. 同条款双方改动
print("C. 同一条款双方编辑 => 409 且保留草案")
p1, p2 = new_draft("P1"), new_draft("P2")
req("PUT", f"/api/drafts/{p1}/clauses/b", {"body": "B-P1"})
req("PUT", f"/api/drafts/{p2}/clauses/b", {"body": "B-P2"})
req("POST", f"/api/drafts/{p1}/publish", {})  # v4
s, d = req("POST", f"/api/drafts/{p2}/publish", {})
check("冲突返回 409", 409, s)
check("冲突类型 same-clause", "same-clause", d["conflicts"][0]["kind"])
check("冲突说明指向 cid=b", "b", d["conflicts"][0]["cid"])
check("冲突说明包含重叠提示", True, "重叠" in d["conflicts"][0]["message"])
s, kept = req("GET", f"/api/drafts/{p2}")
check("草案被保留", "P2", kept["draft"]["name"])

# D. 暂存悬空引用
print("D. 悬空引用可暂存、禁止发布")
g1 = new_draft("DANGLING")
s, _ = req("PUT", f"/api/drafts/{g1}/clauses/a/refs", {"refs": ["b", "ghost"]})
check("写入悬空引用返回 200", 200, s)
s, dg = req("GET", f"/api/drafts/{g1}")
a = next(c for c in dg["draft"]["clauses"] if c["cid"] == "a")
check("悬空引用被标记", ["ghost"], a["danglingRefs"])
check("预检不通过", False, dg["publishCheck"]["ok"])
s, d = req("POST", f"/api/drafts/{g1}/publish", {})
check("悬空时拒绝发布 409", 409, s)
check("原因 dangling-ref", "dangling-ref", d["conflicts"][0]["kind"])

# E. 重放后悬空
print("E. 重放后引用悬空 => 拒绝并保留")
e1, e2 = new_draft("DELB"), new_draft("ADDBREF")
req("PUT", f"/api/drafts/{e1}/clauses/a/refs", {"refs": []})
req("PUT", f"/api/drafts/{e1}/clauses/c/refs", {"refs": ["a"]})
req("DELETE", f"/api/drafts/{e1}/clauses/b")
s, _ = req("POST", f"/api/drafts/{e1}/publish", {})  # v5: a c d
check("E1 发布为 v5", 201, s)
# e2 的基线是 v4（b 仍存在），新增 d->b
req("PUT", f"/api/drafts/{e2}/clauses/d/refs", {"refs": ["b"]})
s, d8 = req("GET", f"/api/drafts/{e2}")
dcl = next(c for c in d8["draft"]["clauses"] if c["cid"] == "d")
check("E2 自身视图不悬空（基线 b 存在）", [], dcl["danglingRefs"])
check("E2 基线落后", True, d8["stale"])
s, d = req("POST", f"/api/drafts/{e2}/publish", {})
check("重放后悬空 409", 409, s)
check("原因 dangling-ref-after-replay", "dangling-ref-after-replay", d["conflicts"][0]["kind"])
check("目标为 b", "b", d["conflicts"][0]["targetCid"])
s, _ = req("GET", f"/api/drafts/{e2}")
check("E2 仍被保留", 200, s)

# F. 移动+新增顺序重放（v5 顺序 a c d）
print("F. 移动与新增的顺序重放")
f1 = new_draft("MOVE")
req("POST", f"/api/drafts/{f1}/clauses", {"cid": "e", "title": "选举", "body": "E", "afterCid": "c"})
req("PUT", f"/api/drafts/{f1}/clauses/a/move", {"afterCid": "d"})
s, d = req("POST", f"/api/drafts/{f1}/publish", {})
check("移动草案发布 201", 201, s)
s, v6 = req("GET", "/api/versions/6")
check("v6 顺序为 c e d a", ["c", "e", "d", "a"], [c["cid"] for c in v6["clauses"]])
check("v6 含新增 e 的正文", "E", next(c for c in v6["clauses"] if c["cid"] == "e")["body"])

# G. 不可变历史
print("G. 历史版本不可变、可完整还原")
s, v1 = req("GET", "/api/versions/1")
check("v1 仍 4 条", 4, len(v1["clauses"]))
check("v1.b 正文未变", "B", v1["clauses"][1]["body"])
check("v1.a 引用仍为 b", ["b"], v1["clauses"][0]["refs"])
s, v5 = req("GET", "/api/versions/5")
check("v5 已删除 b", True, all(c["cid"] != "b" for c in v5["clauses"]))
check("v5 顺序 a c d", ["a", "c", "d"], [c["cid"] for c in v5["clauses"]])
check("v5.c 引用为 a", ["a"], next(c for c in v5["clauses"] if c["cid"] == "c")["refs"])
s, v4 = req("GET", "/api/versions/4")
check("v4.b 保留 B-P1", "B-P1", next(c for c in v4["clauses"] if c["cid"] == "b")["body"])

# 版本间对比
s, cmp = req("GET", "/api/versions/5/compare/4")
kinds = sorted(x["type"] for x in cmp["changes"])
check("v5 vs v4 含删除与引用改动", True, "deleted" in kinds and "refs-changed" in kinds)

# H. 静态页面
print("H. 前端资源")
with urllib.request.urlopen(B + "/") as r:
    html = r.read().decode()
    check("首页 200", 200, r.status)
check("首页含应用标题", True, "社团章程修订台" in html)
with urllib.request.urlopen(B + "/app.js") as r:
    check("app.js 200", 200, r.status)
with urllib.request.urlopen(B + "/styles.css") as r:
    check("styles.css 200", 200, r.status)

print(f"\n通过 {PASS}，失败 {FAIL}")
raise SystemExit(1 if FAIL else 0)
