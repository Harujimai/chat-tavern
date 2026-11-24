// 把上游 SillyTavern 同款 PNG chunk 库打成一个可注入的 IIFE：
//   png-chunks-extract  —— 解析 PNG 块（带 CRC 校验）
//   png-chunk-text      —— tEXt 关键字/正文编解码
//   png-chunks-encode   —— 反向写回（将来导出角色卡用）
import extract from 'png-chunks-extract';
import pngChunkText from 'png-chunk-text';
import encodePng from 'png-chunks-encode';

window.DSHCardLib = {
  extract: extract,
  decode: pngChunkText.decode,
  encode: pngChunkText.encode,
  encodePng: encodePng
};
