/**
 * NEXUS Stock Analyzer — Backend Proxy
 * API Key 仅存在服务端，前端不接触
 *
 * 用法：
 *   1. cp .env.example .env  填入 API Key
 *   2. node server.js
 *   3. 浏览器打开 http://localhost:3200
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ===== 加载 .env =====
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    console.error('❌ 未找到 .env 文件，请复制 .env.example 为 .env 并填入配置');
    process.exit(1);
  }
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    process.env[key] = val;
  }
}

loadEnv();

const PORT = parseInt(process.env.PORT || '3200');
const API_KEY = process.env.DEEPSEEK_API_KEY;
const API_BASE = process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com';

if (!API_KEY) {
  console.error('❌ .env 中缺少 DEEPSEEK_API_KEY');
  process.exit(1);
}

// ===== MIME =====
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ===== 静态文件 =====
function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  // 安全：防止目录遍历
  filePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
  const fullPath = path.join(__dirname, 'public', filePath);

  if (!fullPath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

// ===== 代理 DeepSeek =====
function proxyChat(req, res) {
  // 只接受 POST
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    // 强制使用服务端 Key
    const apiPayload = JSON.stringify({
      model: payload.model || 'deepseek-chat',
      messages: payload.messages,
      stream: !!payload.stream,
      temperature: payload.temperature ?? 0.7,
      max_tokens: payload.max_tokens ?? 4096,
    });

    const apiUrl = new URL(`${API_BASE}/v1/chat/completions`);

    const options = {
      hostname: apiUrl.hostname,
      port: apiUrl.port || 443,
      path: apiUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Length': Buffer.byteLength(apiPayload),
      },
    };

    const proxyReq = https.request(options, (proxyRes) => {
      // 透传状态码和 headers
      const headers = {
        'Content-Type': proxyRes.headers['content-type'] || 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no', // nginx 不缓冲
      };

      // 如果非流式，收集完整响应
      if (!payload.stream) {
        let fullBody = '';
        proxyRes.on('data', chunk => fullBody += chunk);
        proxyRes.on('end', () => {
          res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(fullBody);
        });
        return;
      }

      // 流式：直接 pipe
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);

      proxyRes.on('error', () => {
        try { res.end(); } catch(e) {}
      });
    });

    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
    });

    // 30 秒超时
    proxyReq.setTimeout(120000, () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'Request timeout' }));
    });

    proxyReq.write(apiPayload);
    proxyReq.end();
  });
}

// ===== 主服务器 =====
const server = http.createServer((req, res) => {
  // CORS（同域不需要，留着方便开发）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API 代理路由
  if (req.url === '/api/chat' || req.url.startsWith('/api/chat?')) {
    proxyChat(req, res);
    return;
  }

  // 健康检查
  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', hasKey: !!API_KEY }));
    return;
  }

  // 静态文件
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║   🚀  NEXUS Stock Analyzer           ║');
  console.log('  ║                                      ║');
  console.log(`  ║   http://localhost:${PORT}              ║`);
  console.log('  ║                                      ║');
  console.log(`  ║   API Key: ${API_KEY.slice(0, 6)}...${API_KEY.slice(-4)} (${API_KEY.length} chars)  ║`);
  console.log(`  ║   API Base: ${API_BASE.slice(0, 28).padEnd(28)}  ║`);
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
});
