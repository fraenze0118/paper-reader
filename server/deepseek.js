// DeepSeek 客户端：SSE 流式对话 + JSON 结构化抽取 + 成本/缓存统计
export const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

export const MODELS = {
  flash: 'deepseek-flash',
  pro: 'deepseek-v4-pro',
};

// 官方定价（元 / 百万 token）: [空闲时段, 高峰时段]
// 高峰 = 北京时间周一至周五 9:00-12:00、14:00-18:00（不含法定节假日）
const PRICING = {
  'deepseek-flash': { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  'deepseek-v4-pro': { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] },
};

export function isPeakNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const wd = parts.find((p) => p.type === 'weekday')?.value;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  if (wd === 'Sat' || wd === 'Sun') return false;
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

/** 按官方定价估算本次花费（元） */
export function estimateCost(model, { hit = 0, miss = 0, out = 0 } = {}, date = new Date()) {
  const p = PRICING[model] ?? PRICING['deepseek-flash'];
  const i = isPeakNow(date) ? 1 : 0;
  return (hit * p.hit[i] + miss * p.miss[i] + out * p.out[i]) / 1e6;
}

/** 粗略 token 估算：中文约 1.5 字/token，英文约 4 字符/token，取折中 */
export function approxTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) if (/[\u3400-\u9fff\uff00-\uffef]/.test(ch)) cjk++;
  const rest = text.length - cjk;
  return Math.ceil(cjk / 1.5 + rest / 4);
}

async function post(pathname, apiKey, body, { signal } = {}) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`DeepSeek ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

/**
 * 流式对话。逐块 yield:
 *   { type: 'reasoning', text } | { type: 'text', text } | { type: 'usage', usage }
 */
export async function* chatStream({ apiKey, model, messages, thinking = true, reasoningEffort = 'high', signal }) {
  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 8192,
  };
  // 思考模式：OpenAI 格式下用 thinking.type 开关；不支持 temperature 等参数
  body.thinking = { type: thinking ? 'enabled' : 'disabled' };
  if (thinking) body.reasoning_effort = reasoningEffort;

  const res = await post('/chat/completions', apiKey, body, { signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue; // 忽略 SSE keep-alive 注释
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        if (json.usage) yield { type: 'usage', usage: json.usage };
        const delta = json.choices?.[0]?.delta;
        if (delta?.reasoning_content) yield { type: 'reasoning', text: delta.reasoning_content };
        if (delta?.content) yield { type: 'text', text: delta.content };
      }
    }
  }
}

/** JSON 结构化抽取（元数据识别用）。官方说明有概率返回空 content，这里做重试。 */
export async function chatJson({ apiKey, model = MODELS.flash, system, user, maxTokens = 2048, attempts = 3 }) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await post('/chat/completions', apiKey, {
        model,
        messages: [
          { role: 'system', content: `${system}\n你必须只输出一个合法的 json 对象，不要输出任何解释或 markdown 代码块。` },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
        max_tokens: maxTokens,
        thinking: { type: 'disabled' },
      });
      const json = await res.json();
      const content = json.choices?.[0]?.message?.content;
      if (!content || !content.trim()) {
        lastErr = new Error('模型返回了空 content（官方已知问题）');
        continue;
      }
      const cleaned = content.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      return { data: JSON.parse(cleaned), usage: json.usage };
    } catch (e) {
      lastErr = e;
      if (e.status === 401 || e.status === 402) throw e; // key 无效/余额不足，重试无意义
    }
  }
  throw lastErr ?? new Error('JSON 抽取失败');
}

export async function listModels(apiKey) {
  const res = await fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}`);
  return res.json();
}
