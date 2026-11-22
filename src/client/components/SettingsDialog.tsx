import { useRef, useState, type HTMLAttributes, type PointerEvent } from 'react';
import type { ProviderId } from '../../shared/types';
import { suggestedModels } from '../../shared/models';
import { headers, type Settings } from '../services/settings';

type ModelKey =
  | 'openaiModel'
  | 'geminiModel'
  | 'openaiSttModel'
  | 'geminiSttModel'
  | 'openaiLiveModel'
  | 'geminiLiveModel'
  | 'openaiTranslationModel'
  | 'geminiTranslationModel';
export function SettingsDialog({
  settings,
  onSave,
}: {
  settings: Settings;
  onSave: (settings: Settings) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pressedOutside = useRef(false);
  const [draft, setDraft] = useState(settings);
  const [models, setModels] = useState<Record<ProviderId, string[]>>({
    openai: suggestedModels.openai.map((model) => model.id),
    gemini: suggestedModels.gemini.map((model) => model.id),
  });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const outside = (event: PointerEvent<HTMLDialogElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    );
  };
  async function findModels(provider: ProviderId) {
    setMessage(`${provider === 'openai' ? 'OpenAI' : 'Gemini'} 模型查詢中…`);
    try {
      const response = await fetch(`/api/models?provider=${provider}`, {
        headers: headers({ ...draft, provider }),
      });
      if (!response.ok) throw new Error();
      const result = await response.json();
      setModels((old) => ({
        ...old,
        [provider]: [
          ...new Set([
            ...suggestedModels[provider].map((model) => model.id),
            ...(result.models as string[]),
          ]),
        ],
      }));
      setMessage(
        `找到 ${result.models.length} 個 ${provider === 'openai' ? 'OpenAI' : 'Gemini'} 模型；若清單未列出所需模型，仍可直接輸入 ID。`,
      );
    } catch {
      setMessage('無法取得模型，請確認後端與金鑰設定。');
    }
  }
  function providerField(
    id: string,
    label: string,
    value: ProviderId,
    key: 'provider' | 'sttProvider' | 'liveProvider' | 'translationProvider',
  ) {
    return (
      <>
        <label htmlFor={id}>{label}</label>
        <select
          id={id}
          value={value}
          onChange={(event) => setDraft({ ...draft, [key]: event.target.value as ProviderId })}
        >
          <option value="openai">OpenAI</option>
          <option value="gemini">Google Gemini</option>
        </select>
      </>
    );
  }
  function modelField(
    id: string,
    label: string,
    provider: ProviderId,
    openaiKey: ModelKey,
    geminiKey: ModelKey,
  ) {
    const key = provider === 'openai' ? openaiKey : geminiKey;
    return (
      <>
        <label htmlFor={id}>{label}</label>
        <div className="model-row">
          <input
            id={id}
            list={`models-${provider}`}
            required
            value={draft[key]}
            onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
          />
          <button
            type="button"
            className="secondary"
            aria-label={`查詢${label}的模型`}
            onClick={() => void findModels(provider)}
          >
            查詢模型
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      <button
        className="settings-button"
        onClick={() => {
          setDraft(settings);
          setMessage('');
          setError('');
          dialog.current?.showModal();
        }}
      >
        ⚙ 設定
      </button>
      <dialog
        ref={dialog}
        aria-labelledby="settings-title"
        {...({ closedby: 'any' } as HTMLAttributes<HTMLDialogElement>)}
        onPointerDown={(event) => {
          if (!('closedBy' in HTMLDialogElement.prototype)) pressedOutside.current = outside(event);
        }}
        onPointerUp={(event) => {
          if (
            !('closedBy' in HTMLDialogElement.prototype) &&
            pressedOutside.current &&
            outside(event)
          )
            dialog.current?.close();
          pressedOutside.current = false;
        }}
        onClose={() => {
          if (dialog.current) dialog.current.returnValue = '';
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            try {
              onSave(draft);
              dialog.current?.close();
            } catch {
              setError('無法保存設定，請確認瀏覽器儲存空間。');
            }
          }}
        >
          <div className="dialog-header">
            <div>
              <div className="eyebrow">PROVIDER SETTINGS</div>
              <h2 id="settings-title">AI 服務設定</h2>
            </div>
            <button
              type="button"
              className="close"
              onClick={() => dialog.current?.close()}
              aria-label="關閉設定"
            >
              ×
            </button>
          </div>
          <p className="hint">
            金鑰留空時使用伺服器環境變數。預設僅在目前分頁保留金鑰；建議模型是否可用取決於帳號權限。
          </p>
          <label htmlFor="openai-key">OpenAI API 金鑰</label>
          <input
            id="openai-key"
            type="password"
            autoComplete="off"
            value={draft.openaiKey}
            onChange={(event) => setDraft({ ...draft, openaiKey: event.target.value })}
          />
          <label htmlFor="gemini-key">Gemini API 金鑰</label>
          <input
            id="gemini-key"
            type="password"
            autoComplete="off"
            value={draft.geminiKey}
            onChange={(event) => setDraft({ ...draft, geminiKey: event.target.value })}
          />
          <label className="remember-keys">
            <input
              type="checkbox"
              checked={draft.rememberKeys}
              onChange={(event) => setDraft({ ...draft, rememberKeys: event.target.checked })}
            />{' '}
            在這個瀏覽器記住金鑰
          </label>
          <p className="hint">勾選後，金鑰會保存在此瀏覽器的本機儲存空間；共用裝置請謹慎使用。</p>
          {providerField('provider', '會議紀錄供應商', draft.provider, 'provider')}
          {modelField('model', '會議紀錄模型 ID', draft.provider, 'openaiModel', 'geminiModel')}
          {providerField('stt-provider', '音檔轉錄供應商', draft.sttProvider, 'sttProvider')}
          {modelField(
            'stt-model',
            '音檔轉錄模型 ID',
            draft.sttProvider,
            'openaiSttModel',
            'geminiSttModel',
          )}
          {providerField('live-provider', '即時轉錄供應商', draft.liveProvider, 'liveProvider')}
          {modelField(
            'live-model',
            '即時轉錄模型 ID',
            draft.liveProvider,
            'openaiLiveModel',
            'geminiLiveModel',
          )}
          {providerField(
            'translation-provider',
            '翻譯供應商',
            draft.translationProvider,
            'translationProvider',
          )}
          {modelField(
            'translation-model',
            '翻譯模型 ID',
            draft.translationProvider,
            'openaiTranslationModel',
            'geminiTranslationModel',
          )}
          <datalist id="models-openai">
            {models.openai.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
          <datalist id="models-gemini">
            {models.gemini.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
          <p className="hint" role="status">
            {message}
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={() => dialog.current?.close()}>
              取消
            </button>
            <button className="record" type="submit">
              儲存設定
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
