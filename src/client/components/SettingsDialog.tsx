import { useEffect, useMemo, useRef, useState, type HTMLAttributes } from 'react';
import type { ProviderId } from '../../shared/types';
import { suggestedModels, type ModelCapability } from '../../shared/models';
import { headers, type Settings } from '../services/settings';
import {
  applyThemePreference,
  getSystemColorScheme,
  getThemePreference,
  subscribeThemeStorage,
  type ThemePreference,
} from '../services/theme';
import { closeDialogAnimated, isPointerOutsideDialog, openDialogModal } from '../utils/dialog';
import {
  IconEye,
  IconEyeOff,
  IconLaptop,
  IconMoon,
  IconRefresh,
  IconSettings,
  IconSun,
  IconX,
} from './Icons';

export interface ServerHealth {
  ok: boolean;
  openai: boolean;
  gemini: boolean;
}

type ModelKey =
  | 'openaiModel'
  | 'geminiModel'
  | 'openaiSttModel'
  | 'geminiSttModel'
  | 'openaiLiveModel'
  | 'geminiLiveModel'
  | 'openaiTranslationModel'
  | 'geminiTranslationModel';

const CAPABILITIES: readonly ModelCapability[] = ['live', 'file', 'translation', 'minutes'];

function modelsForCapability(
  provider: ProviderId,
  capability: ModelCapability,
  allModels: string[],
): string[] {
  const recommended = new Set(
    suggestedModels[provider]
      .filter((item) => item.capabilities.includes(capability))
      .map((item) => item.id),
  );
  return [
    ...allModels.filter((id) => recommended.has(id)),
    ...allModels.filter((id) => !recommended.has(id)),
  ];
}

export function SettingsDialog({
  settings,
  onSave,
  serverHealth,
  onRefreshHealth,
}: {
  settings: Settings;
  onSave: (settings: Settings) => void;
  serverHealth?: ServerHealth | null;
  onRefreshHealth?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pressedOutside = useRef(false);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const [draft, setDraft] = useState(settings);
  const [theme, setTheme] = useState<ThemePreference>(getThemePreference);
  const [systemScheme, setSystemScheme] = useState<'light' | 'dark'>(getSystemColorScheme);
  const [showOpenAiKey, setShowOpenAiKey] = useState(false);
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [models, setModels] = useState<Record<ProviderId, string[]>>({
    openai: suggestedModels.openai.map((model) => model.id),
    gemini: suggestedModels.gemini.map((model) => model.id),
  });
  const [loadingProvider, setLoadingProvider] = useState<ProviderId | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const unsubStorage = subscribeThemeStorage(setTheme);
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return () => {
        unsubStorage();
        fetchAbortRef.current?.abort();
      };
    }
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onMediaChange = () => setSystemScheme(media.matches ? 'dark' : 'light');
    media.addEventListener('change', onMediaChange);
    return () => {
      unsubStorage();
      media.removeEventListener('change', onMediaChange);
      fetchAbortRef.current?.abort();
    };
  }, []);

  const capabilityModels = useMemo(() => {
    const map = {} as Record<ProviderId, Record<ModelCapability, string[]>>;
    for (const provider of ['openai', 'gemini'] as const) {
      map[provider] = {} as Record<ModelCapability, string[]>;
      for (const capability of CAPABILITIES) {
        map[provider][capability] = modelsForCapability(provider, capability, models[provider]);
      }
    }
    return map;
  }, [models]);

  async function findModels(provider: ProviderId) {
    fetchAbortRef.current?.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    const label = provider === 'openai' ? 'OpenAI' : 'Gemini';
    setLoadingProvider(provider);
    setMessage(`${label} 模型查詢中…`);
    setError('');
    try {
      const response = await fetch(`/api/models?provider=${provider}`, {
        headers: headers({ ...draft, provider }),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        setMessage(`請檢查或填入有效的 ${label} API 金鑰。`);
        return;
      }
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
        `找到 ${result.models.length} 個 ${label} 模型；若清單未列出所需模型，仍可直接輸入 ID。`,
      );
    } catch {
      if (!controller.signal.aborted) {
        setMessage('無法取得模型，請確認後端連線與金鑰設定。');
      }
    } finally {
      if (fetchAbortRef.current === controller) {
        fetchAbortRef.current = null;
        setLoadingProvider(null);
      }
    }
  }

  function changeTheme(next: ThemePreference) {
    setTheme(next);
    applyThemePreference(next);
  }

  function capabilityCard(
    title: string,
    description: string,
    capability: ModelCapability,
    providerId: string,
    providerValue: ProviderId,
    providerKey: 'provider' | 'sttProvider' | 'liveProvider' | 'translationProvider',
    modelId: string,
    openaiKey: ModelKey,
    geminiKey: ModelKey,
  ) {
    const activeModelKey = providerValue === 'openai' ? openaiKey : geminiKey;
    return (
      <div className="setting-card">
        <div className="setting-card-head">
          <strong>{title}</strong>
          <span>{description}</span>
        </div>
        <label htmlFor={providerId}>供應商</label>
        <select
          id={providerId}
          value={providerValue}
          onChange={(event) =>
            setDraft({ ...draft, [providerKey]: event.target.value as ProviderId })
          }
        >
          <option value="openai">OpenAI</option>
          <option value="gemini">Google Gemini</option>
        </select>
        <label htmlFor={modelId}>模型 ID</label>
        <input
          id={modelId}
          list={`models-${providerValue}-${capability}`}
          required
          value={draft[activeModelKey]}
          onChange={(event) => setDraft({ ...draft, [activeModelKey]: event.target.value })}
        />
      </div>
    );
  }

  function handleSave() {
    const normalized: Settings = {
      ...draft,
      openaiKey: draft.openaiKey.trim(),
      geminiKey: draft.geminiKey.trim(),
      openaiModel: draft.openaiModel.trim(),
      geminiModel: draft.geminiModel.trim(),
      openaiSttModel: draft.openaiSttModel.trim(),
      geminiSttModel: draft.geminiSttModel.trim(),
      openaiLiveModel: draft.openaiLiveModel.trim(),
      geminiLiveModel: draft.geminiLiveModel.trim(),
      openaiTranslationModel: draft.openaiTranslationModel.trim(),
      geminiTranslationModel: draft.geminiTranslationModel.trim(),
    };
    const activeModels = [
      normalized.liveProvider === 'openai'
        ? normalized.openaiLiveModel
        : normalized.geminiLiveModel,
      normalized.sttProvider === 'openai' ? normalized.openaiSttModel : normalized.geminiSttModel,
      normalized.translationProvider === 'openai'
        ? normalized.openaiTranslationModel
        : normalized.geminiTranslationModel,
      normalized.provider === 'openai' ? normalized.openaiModel : normalized.geminiModel,
    ];
    if (activeModels.some((id) => !id)) {
      setError('所有功能模組的模型 ID 皆不可為空白。');
      return;
    }
    try {
      onSave(normalized);
      void closeDialogAnimated(dialog.current);
    } catch {
      setError('無法保存設定，請確認瀏覽器儲存空間。');
    }
  }

  return (
    <>
      <button
        type="button"
        className="settings-button"
        onClick={() => {
          setDraft(settings);
          setMessage('');
          setError('');
          setShowOpenAiKey(false);
          setShowGeminiKey(false);
          onRefreshHealth?.();
          openDialogModal(dialog.current);
        }}
      >
        <IconSettings size={16} />
        <span>設定</span>
      </button>
      <dialog
        ref={dialog}
        className="settings-dialog"
        aria-labelledby="settings-title"
        {...({ closedby: 'any' } as HTMLAttributes<HTMLDialogElement>)}
        onCancel={(event) => {
          event.preventDefault();
          void closeDialogAnimated(dialog.current);
        }}
        onPointerDown={(event) => {
          if (!('closedBy' in HTMLDialogElement.prototype) && dialog.current) {
            pressedOutside.current = isPointerOutsideDialog(event, dialog.current);
          }
        }}
        onPointerUp={(event) => {
          if (
            !('closedBy' in HTMLDialogElement.prototype) &&
            pressedOutside.current &&
            dialog.current &&
            isPointerOutsideDialog(event, dialog.current)
          ) {
            void closeDialogAnimated(dialog.current);
          }
          pressedOutside.current = false;
        }}
        onClose={() => {
          fetchAbortRef.current?.abort();
          if (dialog.current) dialog.current.returnValue = '';
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            handleSave();
          }}
        >
          <div className="dialog-header">
            <div>
              <div className="eyebrow">WORKSPACE &amp; PROVIDERS</div>
              <h2 id="settings-title">設定與 AI 服務</h2>
            </div>
            <button
              type="button"
              className="close"
              onClick={() => void closeDialogAnimated(dialog.current)}
              aria-label="關閉設定"
            >
              <IconX size={18} />
            </button>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">外觀主題</div>
            <div className="theme-segmented" role="group" aria-label="外觀主題">
              <button
                type="button"
                className={theme === 'system' ? 'active' : ''}
                aria-pressed={theme === 'system'}
                onClick={() => changeTheme('system')}
              >
                <IconLaptop size={15} />
                <span>跟隨系統（目前{systemScheme === 'dark' ? '深色' : '淺色'}）</span>
              </button>
              <button
                type="button"
                className={theme === 'light' ? 'active' : ''}
                aria-pressed={theme === 'light'}
                onClick={() => changeTheme('light')}
              >
                <IconSun size={15} />
                <span>淺色</span>
              </button>
              <button
                type="button"
                className={theme === 'dark' ? 'active' : ''}
                aria-pressed={theme === 'dark'}
                onClick={() => changeTheme('dark')}
              >
                <IconMoon size={15} />
                <span>深色</span>
              </button>
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">API 金鑰</div>
            <p className="hint">
              金鑰留空時使用本機後端 .env 設定。預設僅保留於目前分頁，不寫入跨分頁儲存。
            </p>
            <div className="key-grid">
              <div>
                <div className="field-label-row">
                  <label htmlFor="openai-key">OpenAI API 金鑰</label>
                  {serverHealth?.ok && (
                    <span className={`env-badge ${serverHealth.openai ? 'ready' : ''}`}>
                      {serverHealth.openai ? '伺服器已設定備用金鑰' : '未設定伺服器金鑰'}
                    </span>
                  )}
                </div>
                <div className="input-with-action">
                  <input
                    id="openai-key"
                    type={showOpenAiKey ? 'text' : 'password'}
                    autoComplete="off"
                    placeholder="sk-..."
                    value={draft.openaiKey}
                    onChange={(event) => setDraft({ ...draft, openaiKey: event.target.value })}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={showOpenAiKey ? '隱藏 OpenAI 金鑰' : '顯示 OpenAI 金鑰'}
                    onClick={() => setShowOpenAiKey((value) => !value)}
                  >
                    {showOpenAiKey ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                  </button>
                </div>
              </div>
              <div>
                <div className="field-label-row">
                  <label htmlFor="gemini-key">Gemini API 金鑰</label>
                  {serverHealth?.ok && (
                    <span className={`env-badge ${serverHealth.gemini ? 'ready' : ''}`}>
                      {serverHealth.gemini ? '伺服器已設定備用金鑰' : '未設定伺服器金鑰'}
                    </span>
                  )}
                </div>
                <div className="input-with-action">
                  <input
                    id="gemini-key"
                    type={showGeminiKey ? 'text' : 'password'}
                    autoComplete="off"
                    placeholder="AIza..."
                    value={draft.geminiKey}
                    onChange={(event) => setDraft({ ...draft, geminiKey: event.target.value })}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={showGeminiKey ? '隱藏 Gemini 金鑰' : '顯示 Gemini 金鑰'}
                    onClick={() => setShowGeminiKey((value) => !value)}
                  >
                    {showGeminiKey ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                  </button>
                </div>
              </div>
            </div>
            <label className="remember-keys">
              <input
                type="checkbox"
                checked={draft.rememberKeys}
                onChange={(event) => setDraft({ ...draft, rememberKeys: event.target.checked })}
              />
              <span>在這個瀏覽器記住金鑰（共用裝置請謹慎使用）</span>
            </label>
          </div>

          <div className="settings-section">
            <div className="settings-section-head">
              <div>
                <div className="settings-section-title">功能模型配置</div>
                <p className="hint">可跨供應商混搭，並直接輸入或從下拉選單選取模型 ID。</p>
              </div>
              <div className="model-fetch-group">
                <button
                  type="button"
                  className="secondary small-button"
                  disabled={loadingProvider !== null}
                  onClick={() => void findModels('openai')}
                >
                  <IconRefresh size={14} />
                  <span>查詢 OpenAI</span>
                </button>
                <button
                  type="button"
                  className="secondary small-button"
                  disabled={loadingProvider !== null}
                  onClick={() => void findModels('gemini')}
                >
                  <IconRefresh size={14} />
                  <span>查詢 Gemini</span>
                </button>
              </div>
            </div>

            <div className="capability-grid">
              {capabilityCard(
                '即時轉錄',
                '錄音同步串流',
                'live',
                'live-provider',
                draft.liveProvider,
                'liveProvider',
                'live-model',
                'openaiLiveModel',
                'geminiLiveModel',
              )}
              {capabilityCard(
                '音檔轉錄',
                '上傳檔案補轉',
                'file',
                'stt-provider',
                draft.sttProvider,
                'sttProvider',
                'stt-model',
                'openaiSttModel',
                'geminiSttModel',
              )}
              {capabilityCard(
                '即時雙語翻譯',
                '雙向語境口譯',
                'translation',
                'translation-provider',
                draft.translationProvider,
                'translationProvider',
                'translation-model',
                'openaiTranslationModel',
                'geminiTranslationModel',
              )}
              {capabilityCard(
                '會議紀錄生成',
                '潤飾與結構化',
                'minutes',
                'provider',
                draft.provider,
                'provider',
                'model',
                'openaiModel',
                'geminiModel',
              )}
            </div>
          </div>

          {(['openai', 'gemini'] as const).map((provider) =>
            CAPABILITIES.map((capability) => (
              <datalist key={`${provider}-${capability}`} id={`models-${provider}-${capability}`}>
                {capabilityModels[provider][capability].map((item) => (
                  <option key={item} value={item} />
                ))}
              </datalist>
            )),
          )}

          {message && (
            <p className="hint status-feedback" role="status">
              {message}
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}

          <div className="dialog-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => void closeDialogAnimated(dialog.current)}
            >
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
