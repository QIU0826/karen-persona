# B 站登录态写客户端 API 对照（Social P1 / task-30）

> 状态：**2026-10-29 实现完成，未做任何真实写请求**（没有用户 Cookie；遵守「不调用真实写接口」约束）。
> 代码：`src/social/credentials.ts`（Cookie 读取/校验/脱敏）、`src/social/bilibili-auth.ts`（带 Cookie+CSRF 的写客户端）。
> 测试：`src/social/credentials.test.ts`（22 例）、`src/social/bilibili-auth.test.ts`（26 例），全部 mock fetch。
> 端点依据：[bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect)（原仓库默认分支已归档为 `deprecated`，
> 本次抓取 2026-10-29 的社区镜像 [pskdje/bilibili-API-collect](https://github.com/pskdje/bilibili-API-collect) 的 `master` 分支文档）。
> **当前产品范围（2026-10-29）**：Karen 只读 B 站 + 只发 QQ 空间动态；本文件中的写客户端保留为实验代码，bridge 未接线、不需要 B 站 Cookie、不执行真实写。若以后恢复 B 站写，先按 §4 SPIKE 清单复验。
>
> 标注：**文档确认** = 文档给出 URL/方法/参数/返回值；**SPIKE** = 文档不完整/行为需真实 Cookie 验证；**未实测** = 本次没有真实调用。

---

## 0. 安全模型（先看这个）

### 0.1 Cookie 来源与存储

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | `BILIBILI_COOKIE`（env） | cookie 字符串或 JSON；适合 CI/临时调试，注意 shell history 泄漏 |
| 2 | `KAREN_BILIBILI_COOKIE_FILE`（env） | 覆盖 cookie 文件路径 |
| 3 | `data/secrets/bilibili-cookie.json`（默认） | 相对 `process.cwd()`；**必须 0600，目录 0700** |

支持两种格式：

```text
# cookie 字符串
SESSDATA=xxxx%2C1750000000%2Cyyyy; bili_jct=zzzz; DedeUserID=123456
# JSON
{"SESSDATA":"...","bili_jct":"...","DedeUserID":"123456"}
```

### 0.2 代码级保证（有测试覆盖）

- **Cookie 只出现在请求头**（`Cookie: SESSDATA=...; bili_jct=...`），不进日志、不进 `SocialActionResult`、不进 `meta`；
- 日志/审计只允许 `fingerprint`（SESSDATA 的 sha256 前 12 位）、uid、来源、是否 secure；
- 文件权限过宽 → `warnings` + `secure:false`（`requireSecure:true` 时直接拒绝加载）；0600/0700 为推荐；
- 所有错误信息不含 Cookie；测试断言 `JSON.stringify(result)` 不含 SESSDATA/bili_jct；
- 写客户端**永不抛异常**：任何失败都返回 `{ok:false,errorCode,reason}`；
- `dryRun` **默认开启**：只做本地参数校验 + 返回 `meta.dryRun=true` 的预览，不联网；生产 runner 必须显式 `dryRun:false`。

### 0.3 风控/重试策略（不绕风控）

| 情况 | 行为 |
|---|---|
| 网络错误 / 超时 | 最多重试 1 次（400ms 退避），之后 `network_error` |
| HTTP 5xx | 最多重试 1 次（若响应体非 JSON 同样适用），之后 `invalid_response`/`bili_code_*` |
| HTTP 429 | 最多重试 1 次，之后 `rate_limited` |
| HTTP 412 / 业务码 -352 / -412 | **不重试**，`risk_control`；不做 UA/代理/指纹对抗 |
| 业务码 -101 / -111 | 不重试，`not_logged_in` / `csrf_failed` |
| 其他业务码 | 映射为稳定错误码（见 §3），不重试 |

---

## 1. 端点总表（客户端方法 → B 站端点）

| 客户端方法 | HTTP | 端点 | Cookie/CSRF | 关键参数 | 成功返回（取 externalId） | 状态 |
|---|---|---|---|---|---|---|
| `comment(target, content, {root,parent})` | POST | `api.bilibili.com/x/v2/reply/add` | Cookie；表单 `csrf` | `oid`(aid), `type=1`, `message`, `root?`, `parent?` | `data.rpid_str` / `data.rpid` | 文档确认 |
| `reply(target, content, root, parent?)` | POST | 同上 | 同上 | 同上（`root` 必填，`parent` 缺省=root） | 同上 | 文档确认 |
| `deleteComment(target, rpid)` | POST | `api.bilibili.com/x/v2/reply/del` | Cookie；表单 `csrf` | `type=1`, `oid`(aid), `rpid` | — | 文档确认 |
| `like(target)` / `unlike(target)`（视频） | POST | `api.bilibili.com/x/web-interface/archive/like` | Cookie；表单 `csrf` | `aid` 或 `bvid`, `like=1/0` | — | 文档确认 |
| `like/unlike`（`targetType=dynamic`） | POST | `api.bilibili.com/x/dynamic/feed/dyn/thumb` | Cookie；**csrf 放 URL query**；JSON body | `{dyn_id_str, up:1/2}` | — | **SPIKE** |
| `coin(target, multiply)` | POST | `api.bilibili.com/x/web-interface/coin/add` | Cookie；表单 `csrf` | `aid`/`bvid`, `multiply`(1/2), `select_like=0` | — | 文档确认 |
| `favorite(target, folderId)` | POST | `api.bilibili.com/x/v3/fav/resource/deal` | Cookie；表单 `csrf` | `rid`(aid), `type=2`, `add_media_ids=folderId` | — | **SPIKE** |
| `unfavorite(target, folderId)` | POST | 同上 | 同上 | `del_media_ids=folderId` | — | **SPIKE** |
| `follow(uid)` / `unfollow(uid)` | POST | `api.bilibili.com/x/relation/modify` | Cookie；表单 `csrf` | `fid`, `act=1/2`, `re_src=11` | — | 文档确认 |
| `share(target)` | POST | `api.bilibili.com/x/web-interface/share/add` | Cookie；表单 `csrf` | `aid`/`bvid`, `source=web_normal` | — | **SPIKE**（文档鉴权写 buvid3） |
| `postDynamic(content)` | POST | `api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/create` | Cookie；表单 `csrf`+`csrf_token` | `dynamic_id=0, type=4, rid=0, content` | `data.dynamic_id_str` | **SPIKE** |
| `deleteDynamic(id)` | POST | `api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/rm_dynamic` | Cookie；表单 `csrf`+`csrf_token` | `dynamic_id` | — | **SPIKE** |
| `verifyLogin()` | GET | `api.bilibili.com/x/web-interface/nav` | Cookie | — | `data.mid` / `uname` / `level_info.current_level` | 文档确认（只读） |

> `target` 是 `src/social/types.ts` 的 `SocialTarget`：视频需要 `aid` 或 BV 号；评论/回复/删除评论**必须**有 `aid`
> （B 站评论区 `oid=aid`；只给 BV 时客户端返回 `invalid_target`，不自动解析，避免隐式只读请求）。
> 关注/取关也接受 `uid` 字符串/数字；`favorite` 必须显式传收藏夹 id（不替用户猜默认收藏夹）。

---

## 2. 请求/响应细节

### 2.1 公共请求头

```text
User-Agent: Mozilla/5.0 (...) Chrome/124 Safari/537.36
Referer: https://www.bilibili.com/
Accept: application/json, text/plain, */*
Cookie:   SESSDATA=...; bili_jct=...; DedeUserID=...
Content-Type: application/x-www-form-urlencoded （表单端点）| application/json （动态点赞）
```

- CSRF：一律取 Cookie 里的 `bili_jct`；表单端点作为正文 `csrf` 字段，动态点赞作为 URL query `csrf`；
- 动态创建/删除同时带 `csrf` 与 `csrf_token`（文档两种校验字段并存）；
- **URL query 里的 csrf 不进日志**：客户端日志只记录 pathname。

### 2.2 成功响应形状

```json
{"code":0,"message":"0","ttl":1,"data":{ }}
```

- `ok` 判定：HTTP 200 + JSON `code===0`；`externalId` 按上表提取；
- `undoable`：评论/回复/动态/点赞/收藏/关注 = true；`coin`/`share`/删除类 = false；
- `meta`：`{endpoint(仅 path), httpStatus, biliCode, attempts, targetType, contentLength?}`；
  非 dryRun 额外 `{credentialSource, credentialSecure, credentialWarnings}`（**无 Cookie/Cookie 值**）。

### 2.3 错误结果

```json
{"ok":false,"platform":"bilibili","action":"comment","errorCode":"csrf_failed",
 "reason":"csrf_failed","meta":{"endpoint":"/x/v2/reply/add","httpStatus":200,"biliCode":-111,"attempts":1}}
```

`reason` 只放稳定错误码/短语；**不含响应正文、正文内容或 Cookie**。

---

## 3. 业务码 → 稳定错误码

| B 站 code | errorCode | 含义 |
|---|---|---|
| 0 | —（ok） | 成功 |
| -101 | `not_logged_in` | 账号未登录 / Cookie 失效 |
| -102 | `account_banned` | 账号被封停 |
| -104 | `insufficient_coins` | 硬币不足 |
| -111 | `csrf_failed` | CSRF 校验失败（bili_jct 错/过期） |
| -352 / -412 | `risk_control` | 风控拦截（不重试、不绕过） |
| -400 | `invalid_request` | 请求错误（参数/类型） |
| -403 | `forbidden` | 权限不足/账号异常 |
| -404 | `not_found` | 无此项 |
| -509 | `rate_limited` | 请求过于频繁 |
| 65004 / 65006 | `unlike_failed` / `already_liked` | 取消点赞失败 / 重复点赞 |
| 71000 | `duplicate_share` | 重复分享 |
| 10003 / 11010 | `video_not_found` / `content_not_exist` | 稿件/内容不存在 |
| 12002/12052 | `comments_closed` | 评论区已关闭 |
| 12003 | `reply_forbidden` | 禁止回复 |
| 12006/12022 | `comment_not_found` / `comment_deleted` | 评论不存在/已删除 |
| 12009 | `invalid_target_type` | 评论主体 type 不合法 |
| 12015/12016/12025 | `captcha_required` / `sensitive_content` / `content_too_long` | 验证码/敏感/超长 |
| 12035/12051 | `blocked_by_up` / `duplicate_comment` | UP 拉黑/重复评论 |
| 34002–34005 | `cannot_coin_self` / `invalid_coin_amount` / `coin_interval_too_short` / `coin_limit_exceeded` | 投币相关 |
| 4100001 | `invalid_params` | 参数错误（动态接口） |
| 其他 | `bili_code_<code>` | 未收录，保留原码便于排查 |

客户端本地错误码（不发请求）：`invalid_target`、`invalid_content`、`no_credentials`、`network_error`、`invalid_response`、
`risk_control`、`rate_limited`、`unauthorized`、`forbidden`、`internal_error`。

---

## 4. 待 SPIKE（需要真实 Cookie + 低风险测试账号验证）

> 本次按任务约束**没有调用任何真实写接口**，以下按 bilibili-API-collect 文档实现，但行为/字段需真机验证。
> 建议用「仅自己可见的动态 / 自己视频下的评论 / 自己的小号」做验证，并在验证前记录 `dryRun` 输出与审计。

| # | 项 | 疑点/验证方法 | 风险 |
|---|---|---|---|
| 1 | `favorite` / `unfavorite`（`/x/v3/fav/resource/deal`） | 本仓抓取到的 `docs/fav/action.md` 主要覆盖收藏夹增删改/批量删除，未直接给出 `resource/deal` 的表单字段；需确认 `rid/type=2/add_media_ids/del_media_ids` 是否仍有 `csrf` 之外的必填项（如 `platform`） | 低（收藏可手动取消） |
| 2 | `postDynamic`（api.vc `/dynamic_svr/v1/dynamic_svr/create`） | 文档要求 `dynamic_id=0,type=4,rid=0,content`；确认纯文本是否必须带 `extension`/`ctrl`；返回 `dynamic_id_str` 是否稳定 | 中（会公开可见，需审批） |
| 3 | `deleteDynamic`（api.vc `/rm_dynamic`） | 文档同时要求 `csrf_token` 与 `csrf`；确认是否两个都必须、以及删除后返回码 | 低 |
| 4 | 动态点赞（`/x/dynamic/feed/dyn/thumb`） | 文档明确 JSON body `{dyn_id_str, up}` + query `csrf`；确认 `up=0/1/2` 语义（0=切换）与返回 | 低 |
| 5 | `share`（`/x/web-interface/share/add`） | 文档鉴权写 `Cookie (buvid3)`，未提 SESSDATA；确认仅 SESSDATA+bili_jct 是否可用；重复分享 71000 | 低 |
| 6 | 评论 `oid` 与 type | `type=1` 对应视频；动态/专栏/音频等 type 不同；当前客户端只支持视频评论（`invalid_target` 保护） | 低 |
| 7 | BV → aid | 评论/收藏/分享需要 aid；客户端不自动解析 BV（避免隐式只读请求）。上层 runner 可先用现有只读 `lookupBilibiliShare` 取 aid 再传 `target.aid` | 低 |
| 8 | 写接口频率/风控阈值 | 文档无明确阈值；客户端仅做「最多 1 次重试 + 不绕风控」，真正的频率控制由上层 caps/policy 负责（`src/social/types.ts` 硬上限） | 中 |

---

## 5. 上层接入（runner/policy 的调用方式）

> 本任务只交付 credentials/auth 两个模块；`src/social/types.ts`、`config.ts`、`commands`、`bridge` 由 Lead 维护，未修改。

```ts
import { createBilibiliAuthClient } from "./src/social/bilibili-auth.js";
import { loadSocialConfig } from "./src/social/config.js";

const social = loadSocialConfig();
const bili = createBilibiliAuthClient({
  dryRun: social.dryRun,          // 默认 true；生产灰度必须显式关
  cookieFile: social.cookieFile,  // data/secrets/bilibili-cookie.json
});

const status = await bili.verifyLogin();
if (!status.loggedIn) {
  // 不执行写动作；进入 observe 模式、提示用户更新 Cookie
}

// 动作示例（实际应由 policy 审批后调用）
const result = await bili.comment(
  { platform: "bilibili", targetType: "video", targetId: "BV1...", aid: 123456 },
  "这个视频拍得挺舒服的",
);
```

约束：
- 所有写动作必须经 `policy`/审批/`caps`，**不允许 bridge 直接调用**本客户端；
- `dryRun` 预览不联网、不需 Cookie，可用于审批前展示；
- 客户端不做内容审核（`policy/safety` 负责），只做长度/参数/平台校验；
- 客户端不做重试风暴、不切号、不代理、不绕 412；失败即 `ok:false`，由 runner 决定回退/熔断。

---

## 6. 配置速查

| 变量 | 归属 | 默认 | 说明 |
|---|---|---|---|
| `BILIBILI_COOKIE` | credentials | 空 | cookie 字符串或 JSON（优先于文件） |
| `KAREN_BILIBILI_COOKIE_FILE` | config/credentials | `data/secrets/bilibili-cookie.json` | Cookie 文件路径 |
| `KAREN_SOCIAL_DRY_RUN` | config | `on` | 本客户端默认 `dryRun:true`；runner 应传 `social.dryRun` |
| `KAREN_SOCIAL_*_PER_DAY` | config | 见 types | 日上限（代码级硬上限只能调低） |

客户端内部常量：超时 10s（可传 `timeoutMs`）、重试退避 400ms（可传 `retryDelayMs`）、
评论上限 1000 字、动态上限 2000 字（B 站侧还有更严格的敏感/长度校验，以 `12025/12016` 为准）。

---

## 7. 测试覆盖（48 例，全 mock fetch）

### credentials（22）
- cookie 字符串 / JSON / 嵌套 JSON 解析；缺字段/非法格式；`toBilibiliCookieHeader`；
- fingerprint 稳定性/长度/不含原文；env 优先于文件；JSON/字符串文件读取；
- 文件不存在/格式非法；权限 0644 warning + `secure:false`；`requireSecure` 拒绝；`inspectBilibiliCookieFile` 0600/0700；
- `verifyBilibiliLogin`：成功（uid/uname/level）、-101、HTTP 412、超时/网络错误、非 JSON；结果不含 Cookie。

### bilibili-auth（26）
- 错误码映射（含未知码）；dryRun 不联网/不需 Cookie；无凭据 `no_credentials`；
- comment 成功（端点/表单/Cookie/CSRF/rpid/undoable/meta）、-111、-101、HTTP 412；
- HTTP 500 非 JSON 重试 1 次、超时重试 1 次、同步抛错不冒泡；
- 视频 like/unlike、动态 like/unlike（JSON+query csrf）、coin 1/2、follow/unfollow、favorite/unfavorite、
  share、reply root/parent、deleteComment、postDynamic/deleteDynamic（csrf_token+csrf）；
- 非法 target/平台/空内容/超长内容本地拦截；结果/meta 不泄漏 Cookie/正文全文。

---

## 8. 未做 / 后续

- **未做真实写调用**（无 Cookie；按任务要求只 mock）；
- 未做 UI/命令层、审批流、撤销流（Lead 的 policy/runner/store 负责）；
- 未做多账号/切号、Cookie 自动刷新（SESSDATA 会过期，需用户手动更新文件）；
- 未做 BV→aid 自动解析、动态/专栏/音频评论类型；
- 未做频率控制（caps/policy 层负责；客户端只有单次重试）；
- 端点文档以 2026-10-29 抓取的社区镜像为准；实际接口变更需按 §4 SPIKE 清单复验。
