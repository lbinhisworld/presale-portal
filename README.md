# Presale Portal - 售前蓝图知识提炼系统

一个基于 Node.js 和通义千问大模型的 PDF 业务蓝图知识提炼系统，能够从项目业务蓝图中自动提取结构化的行业知识资产。

## 功能特性

- 📄 **PDF 文档解析**：支持上传 PDF 格式的业务蓝图文档
- 🤖 **AI 智能提取**：基于通义千问大模型，自动提取9个维度的知识资产
- 🎯 **结构化输出**：将提取的知识按照标准结构组织展示
- 🔄 **实时反馈**：实时显示 AI 识别过程，让用户了解提取进度
- 📊 **可视化展示**：美观的界面展示提取结果

## 知识提取维度

系统支持从业务蓝图中提取以下9个维度的知识：

1. **项目背景概览** - 客户名称、核心问题、解决方案小结
2. **业务架构层** - 全量流程深度拆解，包含环节、角色、工作内容等
3. **角色价值转换层** - 角色上线前后的工作模式变化和价值评分
4. **需求痛点层** - 一线执行层、中间管理层、高管层的具象痛点
5. **IT 架构与集成层** - 技术架构、系统集成方案
6. **方案策略层** - 主数据规划和痛点解决方案
7. **变革管理层** - 通过技术手段实现的管理约束
8. **资产与资源调度层** - 非人资源的调度逻辑与库存策略
9. **行业规范与标准化层** - 编码体系和专业术语
10. **行业资产总结层** - 可复用的业务逻辑和核心竞争力方案

## 技术栈

- **后端**：Node.js + Express.js
- **前端**：原生 HTML/CSS/JavaScript
- **PDF 解析**：pdf-parse
- **AI 模型**：通义千问 (Tongyi Qianwen)
- **文件上传**：Multer

## 安装与运行

### 前置要求

- Node.js (推荐 v14 或更高版本)
- npm 或 yarn
- 通义千问 API Secret

### 安装步骤

1. 克隆项目（或下载代码）
```bash
git clone <repository-url>
cd presale_portal
```

2. 安装依赖
```bash
npm install
```

3. 启动服务器
```bash
cd presale_portal
node qwen-blueprint-server.js
```

4. 访问应用
打开浏览器访问：http://localhost:3000

### 配置通义千问 Secret

1. 在页面右上角点击配置按钮
2. 输入你的通义千问 API Secret
3. 点击保存

## 使用说明

1. **上传文件**：点击上传区域或拖拽 PDF 文件到上传区域
2. **选择提取维度**：点击对应的按钮提取特定维度的知识
3. **查看结果**：提取完成后，结果会显示在预览区域
4. **识别过程**：可以在识别过程文本框中查看 AI 的提取过程

## 项目结构

```
presale_portal/
├── presale_portal/
│   ├── index.html              # 前端页面
│   └── qwen-blueprint-server.js # 后端服务器
├── package.json                # 项目依赖配置
├── .gitignore                  # Git 忽略文件
└── README.md                   # 项目说明文档
```

## API 端点

- `POST /api/blueprint/analyze` - 完整分析（流式响应）
- `POST /api/blueprint/project-overview` - 项目背景概览
- `POST /api/blueprint/business-architecture` - 业务架构层
- `POST /api/blueprint/role-value-transformation` - 角色价值转换层
- `POST /api/blueprint/pain-points` - 需求痛点层
- `POST /api/blueprint/it-architecture` - IT 架构与集成层
- `POST /api/blueprint/solution-strategy` - 方案策略层
- `POST /api/blueprint/change-management` - 变革管理层
- `POST /api/blueprint/asset-scheduling` - 资产与资源调度层
- `POST /api/blueprint/standards` - 行业规范与标准化层
- `POST /api/blueprint/industry-assets` - 行业资产总结层

## 注意事项

- 确保 PDF 文件大小不超过 50MB
- 通义千问 API Secret 需要有效且具有足够的调用额度
- 建议在本地网络环境下使用，避免 API 调用延迟

## 许可证

本项目仅供内部使用。

## 更新日志

### v1.0.0
- 初始版本发布
- 支持 PDF 文档上传和解析
- 实现9个维度的知识提取
- 支持流式响应和实时反馈
- 美观的 UI 界面

