// 简单示例后端：接收 PDF，调用通义千问抽取关键信息，并返回给前端
// 启动方式（在 presale_portal 目录下）：
//   npm install express multer axios pdf-parse
//   node qwen-blueprint-server.js

const express = require('express');
const multer = require('multer');
const axios = require('axios');
const pdfParse = require('pdf-parse');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 3000;

function log(level, message, detail) {
  const time = new Date().toISOString();
  const payload = { time, level, message };
  if (detail !== undefined) payload.detail = detail;
  const line = `[PreSales-Server] ${JSON.stringify(payload)}`;
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// 健康检查
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// 核心接口：蓝图分析
app.post('/api/blueprint/analyze', upload.single('file'), async (req, res) => {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    const qwenSecret = req.header('X-Qwen-Secret');
    if (!qwenSecret) {
      log('warn', 'missing-qwen-secret', { requestId });
      return res.status(400).json({ error: '缺少通义千问 Secret（X-Qwen-Secret）' });
    }

    if (!req.file) {
      log('warn', 'missing-file', { requestId });
      return res.status(400).json({ error: '未收到文件' });
    }

    const sizeMb = req.file.size / (1024 * 1024);
    log('info', 'receive-file', {
      requestId,
      fileName: req.file.originalname,
      sizeMb: sizeMb.toFixed(2),
    });

    // 解析 PDF 文本
    const pdfData = await pdfParse(req.file.buffer);
    const text = pdfData.text || '';
    log('info', 'pdf-parsed', { requestId, textLength: text.length });

    if (!text.trim()) {
      return res.status(400).json({ error: 'PDF 文本内容为空，无法分析' });
    }

    // 调用通义千问（OpenAI 兼容接口示例）
    const prompt = `
你是一名软件厂商的资深售前顾问，当前拿到的是一个已交付项目的实施规划蓝图（已经被解析成纯文本）。
请从文本中提炼 3 个部分的内容，并严格按照以下 JSON 结构返回（不要输出多余文字）：

{
  "customerInfo": "字符串，概述客户名称、行业、区域、规模、项目背景等信息，控制在 4~6 行。",
  "painPoints": "字符串，以有序列表或分行的方式，归纳 3~6 条核心业务痛点和诉求。",
  "values": "字符串，以有序列表或分行的方式，归纳本项目已实现的关键功能模块及对应业务价值，可包含适量量化指标。"
}

注意：
- 直接输出 JSON，键名必须是 customerInfo / painPoints / values；
- 用简洁专业的售前语言，方便后续沉淀为话术/案例。

以下是项目蓝图的全文内容：
--------------------
${text.slice(0, 15000)}
--------------------
`;

    log('info', 'call-qwen-start', { requestId });

    const qwenResp = await axios.post(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      {
        model: 'qwen-plus',
        messages: [
          { role: 'system', content: '你是擅长从项目文档中提炼售前关键信息的专家。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${qwenSecret}`,
        },
        timeout: 60_000,
      }
    );

    const content =
      qwenResp.data &&
      qwenResp.data.choices &&
      qwenResp.data.choices[0] &&
      qwenResp.data.choices[0].message &&
      qwenResp.data.choices[0].message.content;

    log('info', 'call-qwen-success', { requestId });

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      log('warn', 'qwen-json-parse-failed', {
        requestId,
        raw: content && content.slice(0, 200),
      });
      return res.status(502).json({
        error: '通义千问返回内容无法解析为 JSON',
        raw: content,
      });
    }

    const result = {
      customerInfo: parsed.customerInfo || '',
      painPoints: parsed.painPoints || '',
      values: parsed.values || '',
    };

    log('info', 'analyze-finished', { requestId });
    res.json(result);
  } catch (err) {
    log('error', 'analyze-exception', {
      requestId,
      error: err && err.message,
    });
    res.status(500).json({ error: '服务器内部错误，请查看日志排查问题。' });
  }
});

app.listen(PORT, () => {
  log('info', 'server-started', { port: PORT });
});
