/*
 * ============================================
 *  GLM SSE Proxy - 解决 Trae 调用 GLM 长文本断联问题
 * ============================================
 *
 * 【Trae 配置】
 *   设置 → 模型 → 编辑 GLM 自定义模型 → 自定义请求地址填：
 *   http://localhost:8787/v1
 *
 * 【启动代理】
 *   node "这里填完整文件路径\glm-proxy.js"
 *   或者进入该目录后：node glm-proxy.js
 *
 * 【关闭代理】
 *   在运行代理的终端窗口按 Ctrl + C
 *
 * 【使用流程】
 *   1. 先启动本代理（保持终端窗口开着）
 *   2. 打开 Trae，正常使用 GLM 模型对话
 *   3. 用完后在终端按 Ctrl + C 关闭代理
 *
 * 【代理做了什么】
 *   - 每 15 秒发送心跳包，防止 GLM 思考时 Trae 超时断联
 *   - 过滤 progress_notice 等 Trae 不兼容的 SSE 事件
 *   - 主动速率限制：每分钟最多 N 次请求，超限自动延迟 30s 再发
 *
 * 【速率限制参数（可自行修改）】
 *   MAX_CHAT_RPM = 3         每分钟最多几个 chat 请求
 *   PROACTIVE_COOLDOWN_MS = 30000  超限后延迟多久再发（毫秒）
 * ============================================
 */

const http = require("http");
const https = require("https");

const PORT = 8787;
const TARGET_HOST = "open.bigmodel.cn";
const TARGET_CHAT = "/api/paas/v4/chat/completions";
const TARGET_MODELS = "/api/paas/v4/models";
const KEEP_ALIVE_INTERVAL = 15000;
const UPSTREAM_TIMEOUT = 600000;
const MAX_CHAT_RPM = 3;
const PROACTIVE_COOLDOWN_MS = 30000;

const BLOCKED_SSE_EVENTS = new Set([
  "progress_notice",
  "progress_notice_partial",
]);

let requestIdCounter = 0;

let chatCoolDownUntil = 0;
const recentChatRequests = [];
let chatQueue = Promise.resolve();

function enqueueChat(fn) {
  return new Promise((resolve, reject) => {
    chatQueue = chatQueue.then(() => fn().then(resolve, reject), (err) => {
      console.error("[chat-queue] internal error:", err.message);
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => { resolve(data); });
  });
}

function trackChatRequest() {
  const now = Date.now();
  recentChatRequests.push(now);
  while (recentChatRequests.length && recentChatRequests[0] < now - 60000) {
    recentChatRequests.shift();
  }
}

function getChatRate() {
  const now = Date.now();
  while (recentChatRequests.length && recentChatRequests[0] < now - 60000) {
    recentChatRequests.shift();
  }
  return recentChatRequests.length;
}

function inCoolDown() {
  return Date.now() < chatCoolDownUntil;
}

function setCoolDown(durationMs) {
  const newUntil = Date.now() + durationMs;
  if (newUntil > chatCoolDownUntil) {
    chatCoolDownUntil = newUntil;
    console.log(`[cooloff] entered cooldown for ${(durationMs / 1000).toFixed(1)}s → resume at ${new Date(chatCoolDownUntil).toLocaleTimeString()}`);
  }
}

function getCoolDownRemaining() {
  if (!inCoolDown()) return 0;
  return Math.ceil((chatCoolDownUntil - Date.now()) / 1000);
}

function forwardToGLM(req, res, targetPath, rid) {
  const forwardedHeaders = { ...req.headers };
  forwardedHeaders.host = TARGET_HOST;
  delete forwardedHeaders["accept-encoding"];
  delete forwardedHeaders["connection"];

  const startTime = Date.now();
  let firstByteTime = null;
  let totalBytes = 0;
  let blockedCount = 0;
  let forwardedCount = 0;
  let ended = false;

  function done(reason) {
    if (ended) return;
    ended = true;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const ttfb = firstByteTime ? ((firstByteTime - startTime) / 1000).toFixed(1) : "N/A";
    console.log(`[${rid}] closed reason=${reason} elapsed=${elapsed}s ttfb=${ttfb}s bytes=${totalBytes} forwarded=${forwardedCount} blocked=${blockedCount}`);
  }

  console.log(`[${rid}] forward → https://${TARGET_HOST}${targetPath}`);

  const proxyReq = https.request(
    {
      hostname: TARGET_HOST,
      port: 443,
      path: targetPath,
      method: req.method,
      headers: forwardedHeaders,
      timeout: UPSTREAM_TIMEOUT,
    },
    (proxyRes) => {
      const contentType = proxyRes.headers["content-type"] || "";
      const isSSE = contentType.includes("text/event-stream");

      console.log(`[${rid}] upstream status=${proxyRes.statusCode} sse=${isSSE} ct=${contentType.substring(0, 60)}`);

      const responseHeaders = { ...proxyRes.headers };
      responseHeaders["access-control-allow-origin"] = "*";
      delete responseHeaders["transfer-encoding"];

      if (isSSE) {
        res.writeHead(proxyRes.statusCode, responseHeaders);

        let keepAliveTimer = setInterval(() => {
          try {
            res.write(": keep-alive\n\n");
          } catch (_) {
            clearInterval(keepAliveTimer);
          }
        }, KEEP_ALIVE_INTERVAL);

        let idleTimer = null;
        let buffer = "";

        function resetIdleTimer() {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            const idle = ((Date.now() - (firstByteTime || startTime)) / 1000).toFixed(0);
            console.log(`[${rid}] ⚠ no data from upstream for ${idle}s (buffer=${buffer.length} bytes)`);
          }, 30000);
        }

        proxyRes.on("data", (chunk) => {
          if (!firstByteTime) {
            firstByteTime = Date.now();
            console.log(`[${rid}] first byte after ${((firstByteTime - startTime) / 1000).toFixed(1)}s`);
          }
          totalBytes += chunk.length;
          buffer += chunk.toString();
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            const lines = part.split("\n");
            let shouldBlock = false;
            let sseEventType = null;
            let dataLine = null;
            for (const line of lines) {
              if (line.startsWith("event:")) {
                sseEventType = line.substring(6).trim();
                if (BLOCKED_SSE_EVENTS.has(sseEventType)) {
                  shouldBlock = true;
                  blockedCount++;
                  console.log(`[${rid}] blocked event=${sseEventType}`);
                  break;
                }
              }
              if (line.startsWith("data:")) {
                dataLine = line.substring(5).trim();
              }
            }
            if (!shouldBlock && sseEventType === "error" && dataLine) {
              console.log(`[${rid}] ⛔ SSE error event: ${dataLine.substring(0, 300)}`);
              try {
                const errData = JSON.parse(dataLine);
                if (errData && (errData.code === "rate_limit_exceeded" || (errData.error && errData.error.code === "rate_limit_exceeded"))) {
                  setCoolDown(60000);
                }
              } catch (_) {}
            }
            if (!shouldBlock) {
              forwardedCount++;
              try {
                res.write(part + "\n\n");
              } catch (_) {
                clearInterval(keepAliveTimer);
                if (idleTimer) clearTimeout(idleTimer);
                done("res-write-error");
                return;
              }
            }
          }
          resetIdleTimer();
        });

        proxyRes.on("end", () => {
          if (idleTimer) clearTimeout(idleTimer);
          if (buffer.trim()) {
            const lines = buffer.split("\n");
            let shouldBlock = false;
            for (const line of lines) {
              if (line.startsWith("event:")) {
                const evt = line.substring(6).trim();
                if (BLOCKED_SSE_EVENTS.has(evt)) {
                  shouldBlock = true;
                  blockedCount++;
                  console.log(`[${rid}] blocked:end event=${evt}`);
                  break;
                }
              }
            }
            if (!shouldBlock) {
              forwardedCount++;
              try { res.write(buffer + "\n\n"); } catch (_) {}
            }
          }
          clearInterval(keepAliveTimer);
          res.end();
          done("upstream-end");
        });

        proxyRes.on("error", (err) => {
          if (idleTimer) clearTimeout(idleTimer);
          console.error(`[${rid}] upstream SSE error:`, err.message);
          clearInterval(keepAliveTimer);
          res.end();
          done("upstream-sse-error");
        });

        proxyRes.on("close", () => {
          if (!ended) {
            if (idleTimer) clearTimeout(idleTimer);
            clearInterval(keepAliveTimer);
            res.end();
            done("upstream-close-unexpected");
          }
        });

        req.on("close", () => {
          if (idleTimer) clearTimeout(idleTimer);
          clearInterval(keepAliveTimer);
          done("client-closed");
        });

        res.on("close", () => {
          if (idleTimer) clearTimeout(idleTimer);
          clearInterval(keepAliveTimer);
          if (!ended) done("res-closed");
        });
      } else {
        res.writeHead(proxyRes.statusCode, responseHeaders);

        if (proxyRes.statusCode >= 400) {
          let errorBody = "";
          proxyRes.on("data", (chunk) => { errorBody += chunk.toString(); });
          proxyRes.on("end", () => {
            const ratelimitRemaining = proxyRes.headers["x-ratelimit-remaining"];
            const ratelimitReset = proxyRes.headers["x-ratelimit-reset"];
            const ratelimitLimit = proxyRes.headers["x-ratelimit-limit"];
            const retryAfter = proxyRes.headers["retry-after"];

            console.log(`[${rid}] ⛔ UPSTREAM ERROR status=${proxyRes.statusCode}`);
            if (ratelimitRemaining !== undefined) {
              console.log(`[${rid}] ⛔ RATELIMIT remaining=${ratelimitRemaining} limit=${ratelimitLimit} reset=${ratelimitReset}`);
            }
            if (retryAfter) {
              console.log(`[${rid}] ⛔ RETRY-AFTER ${retryAfter}s`);
            }
            if (errorBody) {
              try {
                const parsed = JSON.parse(errorBody);
                console.log(`[${rid}] ⛔ body=${JSON.stringify(parsed).substring(0, 500)}`);
              } catch (_) {
                console.log(`[${rid}] ⛔ body=${errorBody.substring(0, 500)}`);
              }
            }

            if (proxyRes.statusCode === 429) {
              const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000;
              setCoolDown(delay);
            }

            res.end(errorBody);
            done(`upstream-error-${proxyRes.statusCode}`);
          });
          proxyRes.on("error", (err) => {
            console.error(`[${rid}] upstream error read fail:`, err.message);
            done("upstream-error-read-fail");
          });
        } else {
          proxyRes.pipe(res);
          proxyRes.on("end", () => done("non-sse-end"));
          proxyRes.on("error", (err) => {
            console.error(`[${rid}] upstream non-SSE error:`, err.message);
            done("non-sse-error");
          });
        }
      }
    }
  );

  proxyReq.on("error", (e) => {
    console.error(`[${rid}] request error:`, e.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ error: { message: e.message, type: "proxy_error" } }));
    done("request-error");
  });

  proxyReq.on("timeout", () => {
    console.error(`[${rid}] upstream timeout (${UPSTREAM_TIMEOUT / 1000}s)`);
    proxyReq.destroy();
    done("upstream-timeout");
  });

  return proxyReq;
}

async function handleRequest(req, res) {
  const rid = `req-${++requestIdCounter}`;

  if (req.method === "OPTIONS") {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  console.log(`[${rid}] ${req.method} ${url.pathname}`);

  if (req.method === "GET" && (url.pathname === "/v1" || url.pathname === "/v1/" || url.pathname === "/v1/models")) {
    forwardToGLM(req, res, TARGET_MODELS, rid);
    return;
  }

  if (url.pathname.startsWith("/v1/")) {
    const subPath = url.pathname.replace("/v1", "");
    forwardToGLM(req, res, `/api/paas/v4${subPath}`, rid);
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1") {
    const rawBody = await readBody(req);

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch (_) {
      body = {};
    }

    const isChat = !!(body && body.messages);

    if (isChat) {
      await enqueueChat(async () => {
        const rateBefore = getChatRate();

        if (inCoolDown()) {
          const remaining = getCoolDownRemaining();
          console.log(`[${rid}] ⛔ reactive-cooldown — rejecting, ${remaining}s left (rate=${rateBefore}/min limit=${MAX_CHAT_RPM}/min)`);
          res.writeHead(429, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Retry-After": String(remaining),
          });
          res.end(JSON.stringify({
            error: { message: `GLM rate limit cooldown: retry in ${remaining}s`, type: "proxy_cooldown", code: "rate_limit_exceeded" },
          }));
          return;
        }

        trackChatRequest();
        const rateAfterTrack = getChatRate();

        if (rateAfterTrack > MAX_CHAT_RPM) {
          const delayMs = PROACTIVE_COOLDOWN_MS;
          console.log(`[${rid}] ⏳ proactive-cooldown rate=${rateAfterTrack}/min > limit=${MAX_CHAT_RPM}/min — delaying ${delayMs / 1000}s before forward`);
          await new Promise(r => setTimeout(r, delayMs));
          const rateAfterWait = getChatRate();
          console.log(`[${rid}] ⏳ delay done — rate now=${rateAfterWait}/min, proceeding`);
        }

        const rateFinal = getChatRate();
        console.log(`[${rid}] chat model=${body.model || "?"} max_tokens=${body.max_tokens || "?"} streaming=${body.stream} bodySize=${rawBody.length} hasTools=${!!body.tools} rate=${rateFinal}/min limit=${MAX_CHAT_RPM}/min`);
        const proxyReq = forwardToGLM(req, res, TARGET_CHAT, rid);
        proxyReq.setHeader("Content-Length", Buffer.byteLength(rawBody));
        proxyReq.write(rawBody);
        proxyReq.end();
      });
    } else {
      console.log(`[${rid}] validate → returning fake success`);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({
        id: "chatcmpl-fake-validate",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "glm-5.1",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    }
    return;
  }

  console.log(`[${rid}] unknown ${req.method} ${url.pathname}`);
  res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify({ error: { message: "Not Found", type: "proxy_unknown_path" } }));
}

const server = http.createServer(handleRequest);

server.timeout = 0;
server.keepAliveTimeout = 0;
server.headersTimeout = 0;
server.requestTimeout = 0;

server.on("timeout", (socket) => {
  console.log("[server] socket timeout, destroying");
  socket.destroy();
});

server.listen(PORT, () => {
  console.log(`=== GLM SSE Proxy ===`);
  console.log(`  Local:     http://localhost:${PORT}/v1`);
  console.log(`  Target:    https://${TARGET_HOST}${TARGET_CHAT}`);
  console.log(`  Rate limit: ${MAX_CHAT_RPM} req/min (proactive cooldown ${PROACTIVE_COOLDOWN_MS / 1000}s)`);
  console.log(`  Upstream timeout: ${UPSTREAM_TIMEOUT / 1000}s`);
  console.log(`  Server timeouts: disabled (0)`);
  console.log(`  Keep-alive interval: ${KEEP_ALIVE_INTERVAL / 1000}s`);
  console.log(`  Blocked:   ${[...BLOCKED_SSE_EVENTS].join(", ")}`);
  console.log(`  Idle warning: 30s`);
  console.log(`\nTrae custom request URL → http://localhost:${PORT}/v1\n`);
});
