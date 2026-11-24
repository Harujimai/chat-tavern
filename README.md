# Chat Tavern

基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) v0.1.4 的衍生客户端。


本项目在原版网页的基础上增加了角色预设、生成参数面板和角色卡导入功能，并提供了 **Web 版** 与 **Android 版 (APK)** 两种打包形式。网页核心逻辑保持原样，所有新功能均通过注入脚本和参数拦截实现。并对Android端使用体验进行了优化。

## 功能特性

- **角色预设**：新建、编辑、删除、切换。
- **系统提示词**：支持追加到内置提示词，或直接替换。
- **自定义参数**：自定义温度 (Temperature)、Top P、max_tokens、保留轮数、上下文预算；留空则使用默认值。
- **角色卡导入**：支持酒馆 PNG（解析 tEXt / zTXt / iTXt 数据块，优先级 ccv3 > chara > character）和 JSON 格式，支持点选或拖拽导入。
- **移动端适配**：优化了使用手感，使体验符合直觉，提高了易用性。

## 远景展望（？）

- **功能补完**：支持搜索功能和删除或修改已发送图片、文件的功能。
- **酒馆风味**：支持世界书读取、挂载、修改和预设加载、正则替换。
- **RP优化**：支持切换开场白，并实现更好的前端渲染。

## Web预览（仅展示有差异之处。未展示部分即与上游效果————指上游zip直接解压到手机的效果————一致）
<img width="2514" height="1280" alt="ex3" src="https://github.com/user-attachments/assets/296d58db-e515-4651-877f-aab022b9e4ca" />
<img width="2516" height="1278" alt="ex2" src="https://github.com/user-attachments/assets/ccb2430f-db08-4d4e-aa41-b96115e2f110" />
<img width="1350" height="543" alt="ex1" src="https://github.com/user-attachments/assets/cacabd8a-87ab-4949-aeb9-7493240ffb6a" />

## Android预览（仅展示有差异之处。未展示部分即与上游效果————指上游zip直接解压到手机的效果————一致）
<img width="1256" height="2619" alt="adex4" src="https://github.com/user-attachments/assets/da537261-021c-4c61-bd24-02b73da0fb07" />
<img width="1252" height="2618" alt="adex3" src="https://github.com/user-attachments/assets/74173ec8-86fc-462b-9daf-dc6452cae51e" />
<img width="1252" height="2607" alt="adex2" src="https://github.com/user-attachments/assets/f3420a6c-a2ea-402c-8501-ca6ad384b8c5" />
<img width="1256" height="2620" alt="adex1" src="https://github.com/user-attachments/assets/c677f885-2851-45c5-ab6c-163e36fbfaab" />
