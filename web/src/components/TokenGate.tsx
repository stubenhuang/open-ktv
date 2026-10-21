//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { useEffect, useState } from 'react';
import { isTokenRequired, onTokenRequiredChange, saveAccessToken } from '../api';
import { useI18n } from '../i18n';

/**
 * 访问令牌输入闸门。
 *
 * 出现条件：服务端配了 ACCESS_TOKEN，而浏览器手里没有令牌（或给错了）——
 * api.ts 收到 401 `token_required` 时会广播，这里弹出输入框。
 *
 * 提交后存 localStorage 并**重载页面**：重载是把新令牌应用到这个单页应用
 * 最稳的方式（所有在飞的请求、音频图、轮询全部重建），比手动逐处重试可靠。
 * 桌面本机走回环不过这一关，所以日常使用永远看不到它。
 */
export function TokenGate() {
  const [required, setRequired] = useState(isTokenRequired);
  const [draft, setDraft] = useState('');
  const { t } = useI18n();

  useEffect(() => onTokenRequiredChange(setRequired), []);

  if (!required) return null;

  const submit = () => {
    const token = draft.trim();
    if (!token) return;
    saveAccessToken(token);
    window.location.reload();
  };

  return (
    <div className="token-gate" role="dialog" aria-modal="true" aria-label={t('components.token.title')}>
      <div className="card token-gate-card">
        <div className="panel-card-title">🔒 {t('components.token.title')}</div>
        <p className="page-sub" style={{ marginTop: 6 }}>
          {t('components.token.hint')}
        </p>
        <div className="row" style={{ marginTop: 12, gap: 8 }}>
          <input
            className="text-input"
            style={{ flex: '1 1 auto' }}
            value={draft}
            autoFocus
            placeholder={t('components.token.placeholder')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={!draft.trim()}
            onClick={submit}
          >
            {t('components.token.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}
