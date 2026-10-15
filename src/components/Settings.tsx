import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';

export default function Settings() {
  const config = useApp((s) => s.config);
  const setSettings = useApp((s) => s.setSettings);
  const refreshConfig = useApp((s) => s.refreshConfig);
  const pushToast = useApp((s) => s.pushToast);

  const [key, setKey] = useState('');
  const [model, setModel] = useState(config?.defaultModel ?? 'deepseek-flash');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    setModel(config?.defaultModel ?? 'deepseek-flash');
  }, [config?.defaultModel]);

  const save = async () => {
    await api.saveConfig({ apiKey: key, defaultModel: model });
    await refreshConfig();
    pushToast('ok', '设置已保存');
    setSettings(false);
  };

  return (
    <div className="modal-back" onClick={() => setSettings(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>设置</header>
        <div className="content">
          <div className="field">
            <label>DeepSeek API Key</label>
            <input
              type="password"
              placeholder={config?.hasKey ? `已保存：${config.keyHint}（留空则不变）` : 'sk-...'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <div className="hint">
              仅保存在本机 <code>data/config.json</code>，不会上传到任何地方。
              <br />
              <b>不填也能用</b>：AI 面板会进入「演示模式」，用本地原文检索生成模拟回答，其余功能（导入 / 元数据 / 标注）完全可用。
            </div>
          </div>

          <div className="field">
            <label>默认模型</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="deepseek-flash">deepseek-flash（便宜、快，唯一支持视觉）</option>
              <option value="deepseek-v4-pro">deepseek-v4-pro（更强推理，不支持视觉）</option>
            </select>
            <div className="hint">
              flash：缓存未命中 ¥1~2/M 输入、¥4~8/M 输出；v4-pro：¥4.5~9/M 输入、¥13.5~27/M 输出。
              空闲时段（非工作日 9-12 / 14-18）半价。
            </div>
          </div>

          <div className="field">
            <label>网关地址</label>
            <input type="text" value={config?.baseUrl ?? ''} readOnly />
            <div className="hint">如需走代理，可用环境变量 DEEPSEEK_BASE_URL 覆盖。</div>
          </div>

          {testResult ? (
            <div className={`badge ${testResult.ok ? 'high' : 'low'}`} style={{ padding: '6px 10px' }}>
              {testResult.message}
            </div>
          ) : null}
        </div>
        <footer>
          <button
            className="btn"
            disabled={!config?.hasKey || testing}
            onClick={async () => {
              setTesting(true);
              try {
                setTestResult(await api.testConfig());
              } catch (e) {
                setTestResult({ ok: false, message: (e as Error).message });
              } finally {
                setTesting(false);
              }
            }}
          >
            {testing ? '测试中…' : '测试连接'}
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={() => setSettings(false)}>
            取消
          </button>
          <button className="btn primary" onClick={save}>
            保存
          </button>
        </footer>
      </div>
    </div>
  );
}
