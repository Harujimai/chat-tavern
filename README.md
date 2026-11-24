# Chat Tavern

基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) v0.1.4 的衍生客户端，**非官方项目**。

本项目在原版网页的基础上增加了角色预设、生成参数面板和角色卡导入功能，并提供了 **Web 版** 与 **Android 版 (APK)** 两种打包形式。网页核心逻辑保持原样，所有新功能均通过注入脚本和参数拦截实现。

## 功能特性

- **角色预设**：新建、编辑、删除、切换。
- **系统提示词**：支持追加到内置提示词，或直接替换。
- **生成参数**：自定义温度 (Temperature)、Top P、max_tokens、保留轮数、上下文预算；留空则使用默认值。
- **角色卡导入**：支持酒馆 PNG（解析 tEXt / zTXt / iTXt 数据块，优先级 ccv3 > chara > character）和 JSON 格式，支持点选或拖拽导入。
- **UI 支持**：亮色/暗色主题，桌面/手机响应式布局。

## 使用方式

### 1. Web 端
```bash
python -m http.server 8080