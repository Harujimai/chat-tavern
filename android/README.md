# Chat Tavern - Android 客户端

基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) v0.1.4 的 Android 衍生客户端，**非官方项目**。

网页资源来自 chat-demo v0.1.4，通过 WebView 加载；在原版基础上注入了预设面板、角色卡解析和手势脚本，并补充了移动端壳层适配。

当前客户端版本 0.1.4，versionCode 30101，包名 `com.chattavern.app`。

## 和原版（手机浏览器直接打开）的区别

- 装成 App，有桌面图标，没有地址栏
- 页面跑在 https 本地域上，麦克风可用，语音输入正常
- 返回键逐层关闭：预设面板 → 设置 → 聊天记录抽屉 → 退出
- 状态栏、导航栏颜色跟随页面深浅色
- 导出历史写到系统「下载」目录（原版是 blob 下载，WebView 拿不到内容）
- 导入历史走系统文件选择器
- 键盘弹起不遮挡输入框，在页面上向下滑可收起键盘
- 右滑拉出左侧聊天记录抽屉，左滑拉出右侧抽屉，跟手移动，松手吸附
- 去掉滚动到底部的蓝色辉光，按钮点击有震动反馈
- 角色预设面板：系统提示词、temperature、top_p、max_tokens、历史轮数、上下文预算
- 角色卡导入：从相册选 PNG，读取图中的 chara / ccv3 元数据，也支持 .json

## 目录结构

```text
app/src/main/assets/        原版网页资源
app/src/main/assets_ext/    三个注入脚本
  dsh-preset.js             预设面板、角色卡解析、请求参数改写
  dsh-cardlib.js            PNG chunk 解析（png-chunks-extract 等打包而成）
  dsh-gesture.js            抽屉与面板手势
app/src/main/java/          壳层