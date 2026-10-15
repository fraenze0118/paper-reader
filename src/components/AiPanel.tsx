import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useAi, useApp } from '../store';
import type { Item, MessageMeta } from '../types';

const QUICK = [
  '用 5 句话总结这篇论文',
  '这篇的核心贡献是什么？和已有工作比新在哪',
  '把方法部分讲清楚，我基础一般',
  '实验设计有什么问题？结论被数据支持吗',
  '有哪些局限和未来工作',
];

const fmtCost = (c: number) => (c < 0.01 ? `¥${c.toFixed(5)}` : `¥${c.toFixed(3)}`);
const fmtNum = (n: number) => n.toLocaleString('en-US');

function Rich({ text, onJump }: { text: string; onJump: (p: number) => void }) {
  const parts = text.split(/(\[\[p\.\d+\]\])/g);
  return (
    <>
      {parts.map((p, i) => {
        const m = /^\[\[p\.(\d+)\]\]$/.exec(p);
        if (m)
          return (
            <button key={i} className="page-chip" onClick={() => onJump(Number(m[1]))} title={`跳到第 ${m[1]} 页`}>
              p.{m[1]}
            </button>
          );
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

function MetaLine({ meta }: { meta?: MessageMeta }) {
  if (!meta || (!meta.prompt_tokens && !meta.error && !meta.model)) return null;
  if (meta.error) return <div className="meta" style={{ color: 'var(--danger)' }}>出错：{meta.error}</div>;
  const hit = meta.cache_hit_tokens ?? 0;
  const miss = meta.cache_miss_tokens ?? 0;
  const rate = hit + miss > 0 ? Math.round((hit / (hit + miss)) * 100) : null;
  return (
    <div className="meta">
      <span>{meta.model}</span>
      {meta.thinking ? <span>思考模式</span> : <span>非思考</span>}
      <span>输入 {fmtNum(meta.prompt_tokens ?? 0)}</span>
      <span>输出 {fmtNum(meta.completion_tokens ?? 0)}</span>
      {rate !== null ? <span>缓存命中 {rate}%</span> : null}
      {meta.cost !== undefined ? <span style={{ color: 'var(--ok)' }}>{fmtCost(meta.cost)}</span> : null}
      {meta.elapsed_ms ? <span>{(meta.elapsed_ms / 1000).toFixed(1)}s</span> : null}
    </div>
  );
}

export default function AiPanel({ item, onJumpPage }: { item: Item; onJumpPage: (p: number) => void }) {
  const messages = useAi((s) => s.messages);
  const streaming = useAi((s) => s.streaming);
  const reasoning = useAi((s) => s.reasoning);
  const totals = useAi((s) => s.totals);
  const error = useAi((s) => s.error);
  const ask = useAi((s) => s.ask);
  const stop = useAi((s) => s.stop);
  const clear = useAi((s) => s.clear);
  const config = useApp((s) => s.config);
  const pushToast = useApp((s) => s.pushToast);

  const [input, setInput] = useState('');
  const [showReasoning, setShowReasoning] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, reasoning]);

  const send = () => {
    const q = input.trim();
    if (!q || streaming) return;
    setInput('');
    void ask({ question: q });
  };

  const hitRate = totals.hit + totals.miss > 0 ? Math.round((totals.hit / (totals.hit + totals.miss)) * 100) : null;

  return (
    <div className="ai">
      <div className="ai-scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <div style={{ color: '#9aa1ac', fontSize: 12.4, lineHeight: 1.85 }}>
            {config?.hasKey ? (
              <>
                AI 会把<b>整篇论文全文</b>作为固定前缀读进去（1M 上下文），然后回答你的问题。
                <br />
                回答里的 <span className="page-chip">p.3</span> 可以点击跳回原文页码。
              </>
            ) : (
              <>
                <b>当前是演示模式</b>（未配置 API Key）。
                <br />
                提问会用本地原文检索生成模拟回答，用来展示交互与页码锚点。
                <br />
                在「设置」里填入 DeepSeek API Key 后即为真实模型回答。
              </>
            )}
          </div>
        ) : null}

        {messages.map((msg, i) => (
          <div key={msg.id ?? i} className={`msg ${msg.role} ${msg.meta?.error ? 'error' : ''}`}>
            <div className="role">{msg.role === 'user' ? '你' : `伴读${msg.meta?.model ? ` · ${msg.meta.model}` : ''}`}</div>
            <div className="bubble">
              {msg.role === 'assistant' ? <Rich text={msg.content} onJump={onJumpPage} /> : msg.content}
            </div>
            {msg.role === 'assistant' ? <MetaLine meta={msg.meta} /> : null}
            {msg.role === 'assistant' && msg.content && !msg.meta?.error ? (
              <div style={{ marginTop: 6 }}>
                <button
                  className="btn small"
                  onClick={async () => {
                    await api.createNote(item.id, msg.content, 'ai');
                    await useApp.getState().loadMeta();
                    pushToast('ok', '已存为笔记');
                  }}
                >
                  存为笔记
                </button>
              </div>
            ) : null}
          </div>
        ))}

        {streaming && reasoning ? (
          <div className="thinking">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
              <b>思考中…</b>
              <button className="btn small" style={{ border: 0, background: 'transparent', padding: 0 }} onClick={() => setShowReasoning((v) => !v)}>
                {showReasoning ? '收起' : '展开'}
              </button>
              <span style={{ color: 'var(--faint)' }}>{reasoning.length} 字</span>
            </div>
            {showReasoning ? reasoning.slice(-1500) : null}
          </div>
        ) : null}

        {error ? <div className="msg error"><div className="bubble">{error}</div></div> : null}
      </div>

      <div className="cost-bar">
        <span>
          本次会话 {totals.calls} 次调用 · 输入 {fmtNum(totals.hit + totals.miss)} · 输出 {fmtNum(totals.out)}
        </span>
        {hitRate !== null ? (
          <>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              缓存命中
              <span className="meter">
                <i style={{ width: `${hitRate}%` }} />
              </span>
              {hitRate}%
            </span>
          </>
        ) : null}
        <span style={{ color: 'var(--ok)', fontWeight: 600 }}>{fmtCost(totals.cost)}</span>
        <div style={{ flex: 1 }} />
        {messages.length ? (
          <button
            className="btn small"
            style={{ border: 0, padding: '0 4px' }}
            onClick={() => {
              if (window.confirm('清空这篇文献的对话历史？（标注和笔记不受影响）')) void clear();
            }}
          >
            清空
          </button>
        ) : null}
      </div>

      <div className="composer">
        {messages.length === 0 ? (
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 8 }}>
            {QUICK.map((q) => (
              <button key={q} className="btn small" onClick={() => void ask({ question: q })} disabled={streaming}>
                {q}
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="围绕这篇论文提问…（Enter 发送，Shift+Enter 换行）"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="row">
          <span style={{ fontSize: 11.3, color: 'var(--faint)' }}>
            {config?.hasKey ? `模型 ${config.defaultModel}` : '演示模式（未配置 API Key）'}
          </span>
          <div className="spacer" />
          {streaming ? (
            <button className="btn" onClick={stop}>
              停止
            </button>
          ) : null}
          <button className="btn primary" onClick={send} disabled={streaming || !input.trim()}>
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
