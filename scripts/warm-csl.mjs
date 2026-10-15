// 预热 CSL 样式与 locale 到 data/csl/，之后生成引用可离线使用。
// 用法: node scripts/warm-csl.mjs
import { warmAssets, CSL_DIR } from '../server/cite.js';

console.log('缓存目录:', CSL_DIR);
const result = await warmAssets();
for (const r of result) console.log(' ', r);
