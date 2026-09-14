# LiveCourse

LiveCourse 服务自主学习。学习者说明要学什么，一位 Agent 老师把一堂课教完。

[English](README.md) · [项目文档](packages/docs/content/docs/getting-started.zh-cn.mdx) · [参与贡献](CONTRIBUTING.md) · [安全说明](SECURITY.md)

开发依据是 [docs/spec/](docs/spec/00-index.md)。[docs/LiveCourse_作品简介.md](docs/LiveCourse_作品简介.md) 是对外叙事。

## 当前实现

当前能跑的是单堂课：

- 写出要学的内容，或上传资料
- 生成教学场景
- 一位教师用全双工语音上课，插话后回到原来的节点，并在检查点做测验

默认使用浏览器存储，也可接入 PostgreSQL 持久化。

## 环境要求

- Node.js 20.9 或更高版本
- pnpm 10.28

## 本地开发

```bash
git clone https://github.com/NIKOPACK/livecourse.git
cd livecourse
pnpm install
cp .env.example .env.local
pnpm dev
```

打开 `http://localhost:3000`。请在 `.env.local` 或应用设置页中至少配置一个大语言模型服务；其他服务只在使用相应功能时需要配置。

## 生产构建

```bash
pnpm build
pnpm start
```

使用容器运行：

```bash
cp .env.example .env.local
docker compose up --build
```

PostgreSQL 持久化和视频渲染是可选能力，具体 Compose profile 见 [docker-compose.yml](docker-compose.yml)。

## 验证命令

```bash
pnpm test
pnpm lint
pnpm check:i18n-keys
pnpm check
pnpm build
```

## 目录结构

- `app/`、`components/`：Next.js 应用与界面
- `lib/livecourse/`：课程、会话、证据、实时交互和测验领域逻辑
- `packages/@livecourse/`：内部 DSL、生成、导入、渲染和存储包
- `render-service/`：隔离运行的 MP4 渲染服务
- `packages/docs/`：文档站点

## 许可证

LiveCourse 使用 [MIT License](LICENSE)。第三方以及依法保留的原始版权声明位于各自的许可证文件中。
