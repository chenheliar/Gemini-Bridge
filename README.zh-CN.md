# Gemini Bridge

[English README](./README.md)

Gemini Bridge 是一个桌面应用，用来把 Gemini Web 接到支持 OpenAI-compatible 接口的软件里。

它的重点不是“功能很多”，而是“普通用户也能尽快用起来”。Cookie、代理、默认模型、接口地址这些原本容易把人看晕的内容，现在都整理进了一个中文图形界面里。

![Gemini Bridge 预览图](https://img.heliar.top/file/1776241686234_Gemini_Bridge.png)

## 这是什么

Gemini Bridge 适合这些场景：

- 想在自己的客户端里接入 Gemini
- 不想手动改配置文件、查端口、跑命令
- 希望把常用设置放进一个简单的本地界面里
- 想让同一局域网里的其他设备也能直接调用

## 主要特点

- 中文桌面界面，适合普通用户
- 默认模型可下拉选择并保存
- 端口被占用时自动换一个可用端口
- 支持局域网访问
- 首页直接显示当前可用接口地址
- 内置“使用说明”
- 可查看运行日志
- 运行数据只保存在本地

## 快速开始

### 1. 准备 Cookie

你需要一份可用的 Gemini Cookie，至少包含：

- `__Secure-1PSID`
- `__Secure-1PSIDTS`

格式可以参考：

[`cookies.example.json`](./cookies.example.json)

### 2. 本地运行

```bash
npm install
npm run dev:desktop
```

### 3. 在应用里完成设置

1. 粘贴 Cookie JSON
2. 保存 Cookie
3. 选择默认模型
4. 启动服务
5. 复制应用里显示的接口地址

## 接口地址怎么用

本机使用时，基础地址类似这样：

```text
http://127.0.0.1:3100/v1
```

如果你要给同一局域网里的其他设备使用，请复制应用里显示的“局域网地址”，不要复制 `127.0.0.1`。

例如：

```text
http://192.168.x.x:3100/v1
```

## 打包

### Windows 安装包

```bash
npm run pack:win
```

### macOS 安装包

```bash
npm run pack:mac
```

### 完整构建

```bash
npm run build
```

## 自动发布

项目里已经带了 GitHub Actions 自动发布流程。

当你推送像 `v1.0.1` 这样的版本标签后，可以自动：

- 生成 Windows 安装包
- 生成 macOS 安装包
- 上传到 GitHub Releases

工作流文件：

```text
.github/workflows/release.yml
```

补充说明：

```text
GITHUB_RELEASE.md
```

## 项目结构

```text
electron/             桌面应用入口
src/                  服务端与桥接逻辑
web/                  桌面界面源码
landing.html          宣传单页
cookies.example.json  Cookie 示例
```

## 使用说明

- 项目依赖 Gemini Web 的 Cookie
- 如果 Gemini Web 规则变化，桥接逻辑可能需要跟着更新
- 请求失效时，优先检查 Cookie 是否过期
- 当前 macOS 产物默认是未签名版本

## License

MIT
