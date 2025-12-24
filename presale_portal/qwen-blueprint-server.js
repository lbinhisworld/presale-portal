// 简单示例后端：接收 PDF，调用通义千问抽取关键信息，并返回给前端
// 启动方式（在 presale_portal 目录下）：
//   npm install express multer axios pdf-parse
//   node qwen-blueprint-server.js

const express = require('express');
const multer = require('multer');
const axios = require('axios');
const { PDFParse } = require('pdf-parse');

const app = express();
// 提供静态文件服务，让前端页面可以通过浏览器访问
app.use(express.static(__dirname));
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

// 默认路由：提供 index.html
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// 清理文本格式：移除多余的换行符和空白字符
function cleanTextFormat(text) {
  if (!text || typeof text !== 'string') return text;
  
  // 移除连续的换行符（超过2个的换行符替换为2个）
  text = text.replace(/\n{3,}/g, '\n\n');
  
  // 移除行首行尾的空白字符
  text = text.split('\n').map(line => line.trim()).join('\n');
  
  // 移除段落之间的多余空行（保留一个空行）
  text = text.replace(/\n\n\n+/g, '\n\n');
  
  // 移除开头和结尾的换行符
  text = text.trim();
  
  return text;
}

// 通用辅助函数：解析PDF并调用通义千问
async function extractFromPDF(req, promptTemplate, requestId) {
  const qwenSecret = req.header('X-Qwen-Secret');
  if (!qwenSecret) {
    throw new Error('缺少通义千问 Secret（X-Qwen-Secret）');
  }

  if (!req.file) {
    throw new Error('未收到文件');
  }

  // 解析 PDF 文本
  const parser = new PDFParse({ data: req.file.buffer });
  const pdfData = await parser.getText();
  const text = pdfData.text || '';
  await parser.destroy();

  if (!text.trim()) {
    throw new Error('PDF 文本内容为空，无法分析');
  }

  // 替换提示词模板中的文本占位符
  const prompt = promptTemplate.replace(/\$\{TEXT\}/g, text.slice(0, 15000)).replace(/__TEXT_PLACEHOLDER__/g, text.slice(0, 15000));

  // 调用通义千问
  const qwenResp = await axios.post(
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    {
      model: 'qwen-plus',
      messages: [
        { role: 'system', content: '你是擅长从项目文档中提炼售前关键信息的专家。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      stream: false,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${qwenSecret}`,
      },
      timeout: 120_000,
    }
  );

  const content =
    qwenResp.data &&
    qwenResp.data.choices &&
    qwenResp.data.choices[0] &&
    qwenResp.data.choices[0].message &&
    qwenResp.data.choices[0].message.content;

  if (!content) {
    throw new Error('通义千问 API 返回结果为空');
  }

  // 清理内容，移除可能的markdown代码块标记
  let cleanedContent = content.trim();
  if (cleanedContent.startsWith('```json')) {
    cleanedContent = cleanedContent.replace(/^```json\s*/i, '').replace(/\s*```\s*$/, '');
  } else if (cleanedContent.startsWith('```')) {
    cleanedContent = cleanedContent.replace(/^```\s*/, '').replace(/\s*```\s*$/, '');
  }
  
  const jsonStart = cleanedContent.indexOf('{');
  if (jsonStart > 0) {
    cleanedContent = cleanedContent.substring(jsonStart);
  }
  
  const jsonEnd = cleanedContent.lastIndexOf('}');
  if (jsonEnd > 0 && jsonEnd < cleanedContent.length - 1) {
    cleanedContent = cleanedContent.substring(0, jsonEnd + 1);
  }
  
  cleanedContent = cleanedContent.trim();
  const parsed = JSON.parse(cleanedContent);
  
  // 递归清理所有字符串字段的格式
  function cleanObject(obj) {
    if (typeof obj === 'string') {
      return cleanTextFormat(obj);
    } else if (Array.isArray(obj)) {
      return obj.map(item => cleanObject(item));
    } else if (obj && typeof obj === 'object') {
      const cleaned = {};
      for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
          cleaned[key] = cleanObject(obj[key]);
        }
      }
      return cleaned;
    }
    return obj;
  }
  
  return cleanObject(parsed);
}

// 发送SSE消息的辅助函数
function sendSSE(res, type, messageOrData) {
  try {
    const payload = { type };
    if (type === 'error') {
      payload.error = typeof messageOrData === 'string' ? messageOrData : (messageOrData && messageOrData.error ? messageOrData.error : '未知错误');
    } else if (type === 'result') {
      payload.data = messageOrData;
    } else {
      payload.message = typeof messageOrData === 'string' ? messageOrData : (typeof messageOrData === 'object' ? JSON.stringify(messageOrData) : String(messageOrData));
    }
    const data = JSON.stringify(payload);
    res.write(`data: ${data}\n\n`);
  } catch (err) {
    log('error', 'sse-send-error', { type, error: err.message });
    // 如果序列化失败，发送简单的错误消息
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', error: '发送消息时出错: ' + err.message })}\n\n`);
    } catch (e) {
      // 如果连这个都失败了，就忽略
    }
  }
}

// 核心接口：蓝图分析（支持流式响应）
app.post('/api/blueprint/analyze', upload.single('file'), async (req, res) => {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  
  // 设置SSE响应头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const qwenSecret = req.header('X-Qwen-Secret');
    if (!qwenSecret) {
      log('warn', 'missing-qwen-secret', { requestId });
      sendSSE(res, 'process', '❌ 错误：缺少通义千问 Secret（X-Qwen-Secret）');
      sendSSE(res, 'error', '缺少通义千问 Secret（X-Qwen-Secret）');
      return res.end();
    }

    if (!req.file) {
      log('warn', 'missing-file', { requestId });
      sendSSE(res, 'process', '❌ 错误：未收到文件');
      sendSSE(res, 'error', '未收到文件');
      return res.end();
    }

    const sizeMb = req.file.size / (1024 * 1024);
    log('info', 'receive-file', {
      requestId,
      fileName: req.file.originalname,
      sizeMb: sizeMb.toFixed(2),
    });

    sendSSE(res, 'process', `📄 已接收文件：${req.file.originalname} (${sizeMb.toFixed(2)} MB)`);
    sendSSE(res, 'process', '📖 正在解析 PDF 文件内容...');

    // 解析 PDF 文本
    const parser = new PDFParse({ data: req.file.buffer });
    const pdfData = await parser.getText();
    const text = pdfData.text || '';
    log('info', 'pdf-parsed', { requestId, textLength: text.length });
    
    // 清理资源
    await parser.destroy();

    if (!text.trim()) {
      sendSSE(res, 'process', '❌ PDF 文本内容为空，无法分析');
      sendSSE(res, 'error', 'PDF 文本内容为空，无法分析');
      return res.end();
    }

    sendSSE(res, 'process', `✅ PDF 解析完成，提取文本 ${text.length} 字符`);
    sendSSE(res, 'process', '🤖 正在调用通义千问 API 进行分析...');
    sendSSE(res, 'process', '💭 大模型正在思考和分析文档内容，请稍候...');

    // 调用通义千问（OpenAI 兼容接口示例）
    const prompt = `
角色定义：
你是一位资深的"软件公司行业知识提炼专家"。你的核心目标是从非标准的项目业务蓝图中提取具备高度行业代表性、可复用的知识资产，并构建公司级的行业知识库。

任务目标：
请深度阅读上传的项目蓝图文件，严格按照以下结构进行知识提炼，并以 JSON 格式输出：

{
  "projectOverview": {
    "customerName": "客户全称",
    "coreProblems": "总结客户在管理、效率、数据维度的原始痛点",
    "solutionSummary": "简述本系统如何通过功能模块解决行业特定问题"
  },
  "businessArchitecture": "按以下格式输出蓝图中涉及的所有业务流程：流程 [编号]：[名称]\\n环节名称：业务节点的定义\\n执行角色：该步骤的操作人员\\n工作内容：具体的业务动作\\n流转条件：进入下个节点的前提\\n潜在痛点：该环节在手工阶段或旧模式下的典型问题",
  "roleValueTransformation": "分析核心角色上线前后的工作模式变化，按照价值转化评分 (满分10分) 从高到低排列，格式：排序、角色、价值转换描述、评分。必须涵盖业务架构层涉及的所有角色。",
  "painPoints": {
    "executive": "一线执行层（具象痛点）：描述具体的报价出错、反馈无凭证等动作痛点",
    "management": "中间管理层（具象痛点）：描述具体的进度黑盒、成本偏差、物资短缺等监控痛点",
    "senior": "高管层（具象痛点）：描述具体的 KPI 盲区、利润黑盒、风险预警缺失等决策痛点"
  },
  "solutionStrategy": {
    "masterData": "主数据规划：列出核心主数据、其编码规则及关键的业务联动点",
    "painSolutions": "针对需求痛点层中的核心痛点，按'诊断逻辑、数据结构规划、流程穿越、数据联动、人员联动'五个维度描述"
  },
  "changeManagement": "提炼系统如何通过技术手段实现管理约束（如强制留痕、删除限制等）",
  "assetScheduling": "提炼非人资源（物料、车辆等）的调度逻辑与库存策略",
  "standards": "按以下格式罗列：编码体系：编码名称/术语，具体细节（规则），备注解释\\n专业术语：术语名称，具体细节，备注解释",
  "industryAssets": "总结 3 条最值得在同类项目中复用的业务逻辑或核心竞争力方案"
}

输出要求：
- 格式规范：使用 Markdown 格式，保持内容整洁可读
- 准确引用：所有信息点必须引用蓝图原文，关键术语用 \`\` 标注
- 逻辑严密：确保方案策略层与需求痛点层形成闭环
- **重要：必须直接输出纯 JSON 格式，不要包含任何 markdown 代码块标记（如 \`\`\`json），不要包含任何解释性文字，只输出 JSON 对象本身**

以下是项目蓝图的全文内容：
--------------------
${text.slice(0, 15000)}
--------------------
`;

    log('info', 'call-qwen-start', { requestId });

    // 尝试使用流式API（如果支持）
    let qwenResp;
    try {
      qwenResp = await axios.post(
        'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        {
          model: 'qwen-plus',
          messages: [
            { role: 'system', content: '你是擅长从项目文档中提炼售前关键信息的专家。' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
          stream: false, // 先使用非流式，后续可以改为true支持流式
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${qwenSecret}`,
          },
          timeout: 120_000,
        }
      );
    } catch (apiError) {
      log('error', 'qwen-api-error', { requestId, error: apiError.message });
      sendSSE(res, 'process', '❌ 调用通义千问 API 失败');
      sendSSE(res, 'error', '调用通义千问 API 失败: ' + apiError.message);
      return res.end();
    }

    const content =
      qwenResp.data &&
      qwenResp.data.choices &&
      qwenResp.data.choices[0] &&
      qwenResp.data.choices[0].message &&
      qwenResp.data.choices[0].message.content;

    if (!content) {
      log('error', 'qwen-no-content', {
        requestId,
        responseData: JSON.stringify(qwenResp.data).slice(0, 500),
      });
      sendSSE(res, 'process', '❌ 通义千问 API 返回结果为空');
      sendSSE(res, 'error', '通义千问 API 返回结果为空，请检查 API 响应格式');
      return res.end();
    }

    sendSSE(res, 'process', '✅ 收到大模型返回结果');
    sendSSE(res, 'process', '📝 正在解析和提取关键信息...');

    log('info', 'call-qwen-success', { 
      requestId,
      contentLength: content.length,
      contentPreview: content.slice(0, 100),
    });

    let parsed;
    try {
      if (typeof content !== 'string') {
        throw new Error('Content is not a string');
      }
      
      // 尝试清理内容，移除可能的markdown代码块标记和其他前缀
      let cleanedContent = content.trim();
      
      // 移除markdown代码块标记
      if (cleanedContent.startsWith('```json')) {
        cleanedContent = cleanedContent.replace(/^```json\s*/i, '').replace(/\s*```\s*$/, '');
      } else if (cleanedContent.startsWith('```')) {
        cleanedContent = cleanedContent.replace(/^```\s*/, '').replace(/\s*```\s*$/, '');
      }
      
      // 移除可能的说明文字（在JSON之前）
      const jsonStart = cleanedContent.indexOf('{');
      if (jsonStart > 0) {
        cleanedContent = cleanedContent.substring(jsonStart);
      }
      
      // 移除JSON之后的说明文字
      const jsonEnd = cleanedContent.lastIndexOf('}');
      if (jsonEnd > 0 && jsonEnd < cleanedContent.length - 1) {
        cleanedContent = cleanedContent.substring(0, jsonEnd + 1);
      }
      
      cleanedContent = cleanedContent.trim();
      
      log('info', 'cleaned-content', {
        requestId,
        originalLength: content.length,
        cleanedLength: cleanedContent.length,
        preview: cleanedContent.slice(0, 200),
      });
      
      parsed = JSON.parse(cleanedContent);
      sendSSE(res, 'process', '✅ JSON 解析成功');
      
      // 记录解析后的数据结构
      log('info', 'parsed-structure', {
        requestId,
        hasProjectOverview: !!parsed.projectOverview,
        hasBusinessArchitecture: !!parsed.businessArchitecture,
        keys: Object.keys(parsed),
        projectOverviewType: typeof parsed.projectOverview,
        businessArchitectureLength: parsed.businessArchitecture ? parsed.businessArchitecture.length : 0,
      });
    } catch (e) {
      log('error', 'qwen-json-parse-failed', {
        requestId,
        error: e.message,
        raw: content && content.slice(0, 1000),
        contentLength: content ? content.length : 0,
      });
      sendSSE(res, 'process', '⚠️ 通义千问返回内容无法解析为 JSON，尝试提取纯文本...');
      
      // 尝试从纯文本中提取信息，或者返回原始内容
      parsed = {
        projectOverview: {
          customerName: `JSON解析失败：${e.message}`,
          coreProblems: '请检查AI返回的JSON格式',
          solutionSummary: content ? `原始内容前500字符：${content.slice(0, 500)}` : '无内容'
        },
        businessArchitecture: content ? `原始内容：${content.slice(0, 1000)}` : '解析失败，请查看原始返回内容',
        roleValueTransformation: '解析失败',
        painPoints: {
          executive: '解析失败',
          management: '解析失败',
          senior: '解析失败'
        },
        solutionStrategy: {
          masterData: '解析失败',
          painSolutions: '解析失败'
        },
        changeManagement: '解析失败',
        assetScheduling: '解析失败',
        standards: '解析失败',
        industryAssets: '解析失败',
      };
    }

    // 递归清理对象中所有字符串字段的格式
    function cleanObject(obj) {
      if (typeof obj === 'string') {
        return cleanTextFormat(obj);
      } else if (Array.isArray(obj)) {
        return obj.map(item => cleanObject(item));
      } else if (obj && typeof obj === 'object') {
        const cleaned = {};
        for (const key in obj) {
          if (obj.hasOwnProperty(key)) {
            cleaned[key] = cleanObject(obj[key]);
          }
        }
        return cleaned;
      }
      return obj;
    }
    
    // 确保所有字段都有值，即使是空对象或空字符串
    const rawResult = {
      projectOverview: parsed.projectOverview || {},
      businessArchitecture: parsed.businessArchitecture || '',
      roleValueTransformation: parsed.roleValueTransformation || '',
      painPoints: parsed.painPoints || {},
      solutionStrategy: parsed.solutionStrategy || {},
      changeManagement: parsed.changeManagement || '',
      assetScheduling: parsed.assetScheduling || '',
      standards: parsed.standards || '',
      industryAssets: parsed.industryAssets || '',
    };
    
    // 清理所有字符串字段的格式
    const result = cleanObject(rawResult);
    
    // 记录最终结果的数据结构
    log('info', 'final-result-structure', {
      requestId,
      projectOverviewKeys: result.projectOverview && typeof result.projectOverview === 'object' ? Object.keys(result.projectOverview) : [],
      projectOverviewType: typeof result.projectOverview,
      businessArchitectureLength: result.businessArchitecture ? result.businessArchitecture.length : 0,
      painPointsType: typeof result.painPoints,
      painPointsKeys: result.painPoints && typeof result.painPoints === 'object' ? Object.keys(result.painPoints) : [],
      solutionStrategyType: typeof result.solutionStrategy,
      solutionStrategyKeys: result.solutionStrategy && typeof result.solutionStrategy === 'object' ? Object.keys(result.solutionStrategy) : [],
    });

    sendSSE(res, 'process', '🎉 分析完成！');
    
    // 发送最终结果
    sendSSE(res, 'result', result);
    
    log('info', 'analyze-finished', { requestId });
    res.end();
  } catch (err) {
    log('error', 'analyze-exception', {
      requestId,
      error: err && err.message,
    });
    sendSSE(res, 'process', `❌ 服务器错误: ${err.message}`);
    sendSSE(res, 'error', '服务器内部错误，请查看日志排查问题。');
    res.end();
  }
});

// 项目背景概览提取接口
app.post('/api/blueprint/project-overview', upload.single('file'), async (req, res) => {
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
    log('info', 'receive-file-overview', {
      requestId,
      fileName: req.file.originalname,
      sizeMb: sizeMb.toFixed(2),
    });

    // 解析 PDF 文本
    const parser = new PDFParse({ data: req.file.buffer });
    const pdfData = await parser.getText();
    const text = pdfData.text || '';
    log('info', 'pdf-parsed-overview', { requestId, textLength: text.length });
    
    // 清理资源
    await parser.destroy();

    if (!text.trim()) {
      return res.status(400).json({ error: 'PDF 文本内容为空，无法分析' });
    }

    // 调用通义千问提取项目背景概览
    const prompt = `
角色定义：
你是一位资深的"软件公司行业知识提炼专家"。你的核心目标是从非标准的项目业务蓝图中提取具备高度行业代表性、可复用的知识资产，并构建公司级的行业知识库。

任务目标：
请深度阅读上传的项目蓝图文件，严格按照以下结构进行知识提炼，并以 JSON 格式输出：

{
  "customerName": "明确输出客户全称",
  "coreProblems": "以要点形式罗列客户在管理、效率、数据维度的原始痛点，每个要点一行，使用 Markdown 列表格式（- 或 * 开头）",
  "solutionSummary": "以要点形式罗列本系统如何通过功能模块解决行业特定问题，每个要点一行，使用 Markdown 列表格式（- 或 * 开头）"
}

输出要求：
- 直接输出纯 JSON 格式，不要包含任何 markdown 代码块标记（如 \`\`\`json），不要包含任何解释性文字，只输出 JSON 对象本身
- 准确引用：所有信息点必须引用蓝图原文，关键术语用 \`\` 标注
- 格式要求：
  * coreProblems 字段必须使用 Markdown 无序列表格式，每个痛点独立一行，例如：
    "- 管理维度：缺乏统一的数据管理平台，各部门数据孤岛严重
    - 效率维度：手工录入数据耗时耗力，错误率高
    - 数据维度：历史数据无法追溯，决策缺乏数据支撑"
  * solutionSummary 字段必须使用 Markdown 无序列表格式，每个解决方案独立一行，例如：
    "- 通过主数据管理模块统一数据标准，打通各部门数据壁垒
    - 通过自动化流程减少手工操作，提升数据录入效率和准确性
    - 通过数据追溯功能记录全生命周期数据，为决策提供依据"

以下是项目蓝图的全文内容：
--------------------
${text.slice(0, 15000)}
--------------------
`;

    log('info', 'call-qwen-overview-start', { requestId });

    const qwenResp = await axios.post(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      {
        model: 'qwen-plus',
        messages: [
          { role: 'system', content: '你是擅长从项目文档中提炼售前关键信息的专家。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        stream: false,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${qwenSecret}`,
        },
        timeout: 120_000,
      }
    );

    const content =
      qwenResp.data &&
      qwenResp.data.choices &&
      qwenResp.data.choices[0] &&
      qwenResp.data.choices[0].message &&
      qwenResp.data.choices[0].message.content;

    if (!content) {
      log('error', 'qwen-no-content-overview', {
        requestId,
        responseData: JSON.stringify(qwenResp.data).slice(0, 500),
      });
      return res.status(500).json({ error: '通义千问 API 返回结果为空' });
    }

    log('info', 'call-qwen-overview-success', { 
      requestId,
      contentLength: content.length,
      contentPreview: content.slice(0, 100),
    });

    let parsed;
    try {
      if (typeof content !== 'string') {
        throw new Error('Content is not a string');
      }
      
      // 清理内容，移除可能的markdown代码块标记
      let cleanedContent = content.trim();
      if (cleanedContent.startsWith('```json')) {
        cleanedContent = cleanedContent.replace(/^```json\s*/i, '').replace(/\s*```\s*$/, '');
      } else if (cleanedContent.startsWith('```')) {
        cleanedContent = cleanedContent.replace(/^```\s*/, '').replace(/\s*```\s*$/, '');
      }
      
      const jsonStart = cleanedContent.indexOf('{');
      if (jsonStart > 0) {
        cleanedContent = cleanedContent.substring(jsonStart);
      }
      
      const jsonEnd = cleanedContent.lastIndexOf('}');
      if (jsonEnd > 0 && jsonEnd < cleanedContent.length - 1) {
        cleanedContent = cleanedContent.substring(0, jsonEnd + 1);
      }
      
      cleanedContent = cleanedContent.trim();
      parsed = JSON.parse(cleanedContent);
    } catch (e) {
      log('warn', 'qwen-json-parse-failed-overview', {
        requestId,
        error: e.message,
        raw: content && content.slice(0, 500),
      });
      return res.status(502).json({
        error: '通义千问返回内容无法解析为 JSON',
        raw: content.slice(0, 500),
      });
    }

    const result = {
      customerName: cleanTextFormat(parsed.customerName || ''),
      coreProblems: cleanTextFormat(parsed.coreProblems || ''),
      solutionSummary: cleanTextFormat(parsed.solutionSummary || ''),
    };

    log('info', 'overview-finished', { requestId });
    res.json(result);
  } catch (err) {
    log('error', 'overview-exception', {
      requestId,
      error: err && err.message,
    });
    res.status(500).json({ error: '服务器内部错误，请查看日志排查问题。' });
  }
});

// 业务架构层提取接口
app.post('/api/blueprint/business-architecture', upload.single('file'), async (req, res) => {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    const prompt = `
角色定义：
你是一位资深的"软件公司行业知识提炼专家"。你的核心目标是从非标准的项目业务蓝图中提取具备高度行业代表性、可复用的知识资产，并构建公司级的行业知识库。

任务目标：
请深度阅读上传的项目蓝图文件，提取业务架构层信息，并以 JSON 格式输出：

{
  "businessArchitecture": "按以下格式输出蓝图中涉及的所有业务流程：\\n流程 [编号]：[名称]\\n环节名称：业务节点的定义\\n执行角色：该步骤的操作人员\\n工作内容：具体的业务动作（如选择产品、自动计算、审批等）\\n流转条件：进入下个节点的前提\\n潜在痛点：该环节在手工阶段或旧模式下的典型问题"
}

输出要求：
- 直接输出纯 JSON 格式，不要包含任何 markdown 代码块标记（如 \`\`\`json），不要包含任何解释性文字，只输出 JSON 对象本身
- 准确引用：所有信息点必须引用蓝图原文，关键术语用 \`\` 标注
- 格式规范：使用 Markdown 格式，保持内容整洁可读

以下是项目蓝图的全文内容：
--------------------
__TEXT_PLACEHOLDER__
--------------------
`;
    const parsed = await extractFromPDF(req, prompt, requestId);
    log('info', 'business-architecture-finished', { requestId });
    res.json({ businessArchitecture: parsed.businessArchitecture || '' });
  } catch (err) {
    log('error', 'business-architecture-exception', { requestId, error: err && err.message });
    res.status(500).json({ error: err.message || '服务器内部错误，请查看日志排查问题。' });
  }
});

// 角色价值转换层提取接口
app.post('/api/blueprint/role-value-transformation', upload.single('file'), async (req, res) => {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    const prompt = `
角色定义：
你是一位资深的"软件公司行业知识提炼专家"。你的核心目标是从非标准的项目业务蓝图中提取具备高度行业代表性、可复用的知识资产，并构建公司级的行业知识库。

任务目标：
请深度阅读上传的项目蓝图文件，提取角色价值转换层信息，并以 JSON 格式输出：

{
  "roleValueTransformation": "分析核心角色上线前后的工作模式变化，按照价值转化评分 (满分10分) 从高到低排列，格式：排序、角色、价值转换描述、评分。必须涵盖业务架构层涉及的所有角色。使用 Markdown 表格格式输出"
}

输出要求：
- 直接输出纯 JSON 格式，不要包含任何 markdown 代码块标记（如 \`\`\`json），不要包含任何解释性文字，只输出 JSON 对象本身
- 准确引用：所有信息点必须引用蓝图原文，关键术语用 \`\` 标注

以下是项目蓝图的全文内容：
--------------------
__TEXT_PLACEHOLDER__
--------------------
`;
    const parsed = await extractFromPDF(req, prompt, requestId);
    log('info', 'role-value-transformation-finished', { requestId });
    res.json({ roleValueTransformation: parsed.roleValueTransformation || '' });
  } catch (err) {
    log('error', 'role-value-transformation-exception', { requestId, error: err && err.message });
    res.status(500).json({ error: err.message || '服务器内部错误，请查看日志排查问题。' });
  }
});

// 需求痛点层提取接口
app.post('/api/blueprint/pain-points', upload.single('file'), async (req, res) => {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    const prompt = `
角色定义：
你是一位资深的"软件公司行业知识提炼专家"。你的核心目标是从非标准的项目业务蓝图中提取具备高度行业代表性、可复用的知识资产，并构建公司级的行业知识库。

任务目标：
请深度阅读上传的项目蓝图文件，提取需求痛点层信息，必须以具象化方式描述，涉及具体的人、事、指标、工作项，严禁泛泛而谈。以 JSON 格式输出：

{
  "executive": "一线执行层（具象痛点）：描述具体的报价出错、反馈无凭证等动作痛点，使用 Markdown 列表格式",
  "management": "中间管理层（具象痛点）：描述具体的进度黑盒、成本偏差、物资短缺等监控痛点，使用 Markdown 列表格式",
  "senior": "高管层（具象痛点）：描述具体的 KPI 盲区、利润黑盒、风险预警缺失等决策痛点，使用 Markdown 列表格式"
}

输出要求：
- 直接输出纯 JSON 格式，不要包含任何 markdown 代码块标记（如 \`\`\`json），不要包含任何解释性文字，只输出 JSON 对象本身
- 准确引用：所有信息点必须引用蓝图原文，关键术语用 \`\` 标注
- 必须具象化，涉及具体的人、事、指标、工作项

以下是项目蓝图的全文内容：
--------------------
__TEXT_PLACEHOLDER__
--------------------
`;
    const parsed = await extractFromPDF(req, prompt, requestId);
    log('info', 'pain-points-finished', { requestId });
    res.json({
      executive: parsed.executive || '',
      management: parsed.management || '',
      senior: parsed.senior || '',
    });
  } catch (err) {
    log('error', 'pain-points-exception', { requestId, error: err && err.message });
    res.status(500).json({ error: err.message || '服务器内部错误，请查看日志排查问题。' });
  }
});

// IT 架构与集成层提取接口
app.post('/api/blueprint/it-architecture', upload.single('file'), async (req, res) => {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    const prompt = `
角色定义：
你是一位资深的"软件公司行业知识提炼专家"。你的核心目标是从非标准的项目业务蓝图中提取具备高度行业代表性、可复用的知识资产，并构建公司级的行业知识库。

任务目标：
请深度阅读上传的项目蓝图文件，提取 IT 架构与集成层信息，并以 JSON 格式输出：

{
  "itArchitecture": "描述系统的技术架构、系统集成方案、数据接口设计、第三方系统对接等 IT 架构相关内容，使用 Markdown 格式"
}

输出要求：
- 直接输出纯 JSON 格式，不要包含任何 markdown 代码块标记（如 \`\`\`json），不要包含任何解释性文字，只输出 JSON 对象本身
- 准确引用：所有信息点必须引用蓝图原文，关键术语用 \`\` 标注

以下是项目蓝图的全文内容：
--------------------
__TEXT_PLACEHOLDER__
--------------------
`;
    const parsed = await extractFromPDF(req, prompt, requestId);
    log('info', 'it-architecture-finished', { requestId });
    res.json({ itArchitecture: parsed.itArchitecture || '' });
  } catch (err) {
    log('error', 'it-architecture-exception', { requestId, error: err && err.message });
    res.status(500).json({ error: err.message || '服务器内部错误，请查看日志排查问题。' });
  }
});

// 方案策略层提取接口
app.post('/api/blueprint/solution-strategy', upload.single('file'), async (req, res) => {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    const prompt = `
角色定义：
你是一位资深的"软件公司行业知识提炼专家"。你的核心目标是从非标准的项目业务蓝图中提取具备高度行业代表性、可复用的知识资产，并构建公司级的行业知识库。

任务目标：
请深度阅读上传的项目蓝图文件，提取方案策略层信息，并以 JSON 格式输出：

{
  "masterData": "5.1 主数据规划：列出核心主数据、其编码规则及关键的业务联动点，使用 Markdown 格式",
  "painSolutions": "5.2 痛点方案罗列：\\n\\n首先，从蓝图中提取所有需求痛点（包括一线执行层、中间管理层、高管层的痛点）。\\n\\n然后，针对每个痛点，列出对应的解决方案。每个痛点的解决方案必须包含以下二级要点：\\n- 数据结构：描述解决该痛点所需的数据结构设计\\n- 流程：描述解决该痛点的业务流程设计\\n- 联动：描述解决该痛点所需的数据联动、人员联动等机制\\n\\n输出格式示例：\\n\\n### 痛点1：痛点描述\\n**解决方案：**\\n- 数据结构：***\\n- 流程：***\\n- 联动：***\\n\\n### 痛点2：痛点描述\\n**解决方案：**\\n- 数据结构：***\\n- 流程：***\\n- 联动：***"
}

输出要求：
- 直接输出纯 JSON 格式，不要包含任何 markdown 代码块标记（如 \`\`\`json），不要包含任何解释性文字，只输出 JSON 对象本身
- 准确引用：所有信息点必须引用蓝图原文，关键术语用 \`\` 标注
- 逻辑严密：确保方案策略层与需求痛点层形成闭环，每个痛点都要有对应的解决方案
- 格式要求：
  * painSolutions 字段必须首先列出所有需求痛点，然后针对每个痛点提供解决方案
  * 每个痛点的解决方案必须包含三个二级要点：数据结构、流程、联动
  * 每个二级要点都要有具体的内容描述，不能为空
  * 痛点描述要准确引用蓝图中的痛点内容
  * 使用 Markdown 格式，保持结构清晰

以下是项目蓝图的全文内容：
--------------------
__TEXT_PLACEHOLDER__
--------------------
`;
    const parsed = await extractFromPDF(req, prompt, requestId);
    log('info', 'solution-strategy-finished', { requestId });
    res.json({
      masterData: parsed.masterData || '',
      painSolutions: parsed.painSolutions || '',
    });
  } catch (err) {
    log('error', 'solution-strategy-exception', { requestId, error: err && err.message });
    res.status(500).json({ error: err.message || '服务器内部错误，请查看日志排查问题。' });
  }
});

// 变革管理层提取接口
app.post('/api/blueprint/change-management', upload.single('file'), async (req, res) => {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    const prompt = `
角色定义：
你是一位资深的"软件公司行业知识提炼专家"。你的核心目标是从非标准的项目业务蓝图中提取具备高度行业代表性、可复用的知识资产，并构建公司级的行业知识库。

任务目标：
请深度阅读上传的项目蓝图文件，提取变革管理层信息，并以 JSON 格式输出：

{
  "changeManagement": "提炼系统如何通过技术手段实现管理约束（如强制留痕、删除限制等），使用 Markdown 格式"
}

输出要求：
- 直接输出纯 JSON 格式，不要包含任何 markdown 代码块标记（如 \`\`\`json），不要包含任何解释性文字，只输出 JSON 对象本身
- 准确引用：所有信息点必须引用蓝图原文，关键术语用 \`\` 标注

以下是项目蓝图的全文内容：
--------------------
__TEXT_PLACEHOLDER__
--------------------
`;
    const parsed = await extractFromPDF(req, prompt, requestId);
    log('info', 'change-management-finished', { requestId });
    res.json({ changeManagement: parsed.changeManagement || '' });
  } catch (err) {
    log('error', 'change-management-exception', { requestId, error: err && err.message });
    res.status(500).json({ error: err.message || '服务器内部错误，请查看日志排查问题。' });
  }
});

// 资产与资源调度层提取接口
app.post('/api/blueprint/asset-scheduling', upload.single('file'), async (req, res) => {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    const prompt = `
角色定义：
你是一位资深的"软件公司行业知识提炼专家"。你的核心目标是从非标准的项目业务蓝图中提取具备高度行业代表性、可复用的知识资产，并构建公司级的行业知识库。

任务目标：
请深度阅读上传的项目蓝图文件，提取资产与资源调度层信息，并以 JSON 格式输出：

{
  "assetScheduling": "提炼非人资源（物料、车辆等）的调度逻辑与库存策略，使用 Markdown 格式"
}

输出要求：
- 直接输出纯 JSON 格式，不要包含任何 markdown 代码块标记（如 \`\`\`json），不要包含任何解释性文字，只输出 JSON 对象本身
- 准确引用：所有信息点必须引用蓝图原文，关键术语用 \`\` 标注

以下是项目蓝图的全文内容：
--------------------
__TEXT_PLACEHOLDER__
--------------------
`;
    const parsed = await extractFromPDF(req, prompt, requestId);
    log('info', 'asset-scheduling-finished', { requestId });
    res.json({ assetScheduling: parsed.assetScheduling || '' });
  } catch (err) {
    log('error', 'asset-scheduling-exception', { requestId, error: err && err.message });
    res.status(500).json({ error: err.message || '服务器内部错误，请查看日志排查问题。' });
  }
});

// 行业规范与标准化层提取接口
app.post('/api/blueprint/standards', upload.single('file'), async (req, res) => {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    const prompt = `
角色定义：
你是一位资深的"软件公司行业知识提炼专家"。你的核心目标是从非标准的项目业务蓝图中提取具备高度行业代表性、可复用的知识资产，并构建公司级的行业知识库。

任务目标：
请深度阅读上传的项目蓝图文件，提取行业规范与标准化层信息，并以 JSON 格式输出：

{
  "standards": "按以下格式罗列：编码体系：编码名称/术语，具体细节（规则），备注解释\\n专业术语：术语名称，具体细节，备注解释。使用 Markdown 格式"
}

输出要求：
- 直接输出纯 JSON 格式，不要包含任何 markdown 代码块标记（如 \`\`\`json），不要包含任何解释性文字，只输出 JSON 对象本身
- 准确引用：所有信息点必须引用蓝图原文，关键术语用 \`\` 标注

以下是项目蓝图的全文内容：
--------------------
__TEXT_PLACEHOLDER__
--------------------
`;
    const parsed = await extractFromPDF(req, prompt, requestId);
    log('info', 'standards-finished', { requestId });
    res.json({ standards: parsed.standards || '' });
  } catch (err) {
    log('error', 'standards-exception', { requestId, error: err && err.message });
    res.status(500).json({ error: err.message || '服务器内部错误，请查看日志排查问题。' });
  }
});

// 行业资产总结层提取接口
app.post('/api/blueprint/industry-assets', upload.single('file'), async (req, res) => {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    const prompt = `
角色定义：
你是一位资深的"软件公司行业知识提炼专家"。你的核心目标是从非标准的项目业务蓝图中提取具备高度行业代表性、可复用的知识资产，并构建公司级的行业知识库。

任务目标：
请深度阅读上传的项目蓝图文件，提取行业资产总结层信息，并以 JSON 格式输出：

{
  "industryAssets": "总结 3 条最值得在同类项目中复用的业务逻辑或核心竞争力方案，使用 Markdown 列表格式"
}

输出要求：
- 直接输出纯 JSON 格式，不要包含任何 markdown 代码块标记（如 \`\`\`json），不要包含任何解释性文字，只输出 JSON 对象本身
- 准确引用：所有信息点必须引用蓝图原文，关键术语用 \`\` 标注

以下是项目蓝图的全文内容：
--------------------
__TEXT_PLACEHOLDER__
--------------------
`;
    const parsed = await extractFromPDF(req, prompt, requestId);
    log('info', 'industry-assets-finished', { requestId });
    res.json({ industryAssets: parsed.industryAssets || '' });
  } catch (err) {
    log('error', 'industry-assets-exception', { requestId, error: err && err.message });
    res.status(500).json({ error: err.message || '服务器内部错误，请查看日志排查问题。' });
  }
});

app.listen(PORT, () => {
  log('info', 'server-started', { port: PORT });
  console.log(`\n✅ 服务器已启动！`);
  console.log(`📱 预览地址：http://localhost:${PORT}/index.html\n`);
});
