//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

import { useI18n } from '../i18n';

/**
 * 语言切换器。
 *
 * 设计成原生 `<select>`：键盘可达、读屏认得、移动端会用系统选择器，
 * 比自绘下拉少一大笔代码，也更符合「主题化组件替换浏览器原生控件」的例外情形 ——
 * 这个控件的内容由语言决定，样式跟随主题就够。
 *
 * 语言名字来自 `localeLabelsIn`：当前是中文时用母语自称（`English`），
 * 当前是其他语言时写成「简体中文 (Chinese)」这种双语形式 —— 只懂中文的人
 * 在英文界面里也找得到中文入口。这是 i18n 的惯例。
 */
export function LanguageSwitcher({ id }: { id?: string }) {
  const { locale, locales, localeLabels, setLocale, t } = useI18n();
  return (
    <label className="lang-switcher">
      <span className="lang-switcher-label" aria-hidden="true">
        {t('app.language')}
      </span>
      <select
        id={id}
        className="lang-switcher-select"
        value={locale}
        onChange={(event) => setLocale(event.target.value as typeof locale)}
        aria-label={t('app.language')}
      >
        {locales.map((item) => (
          <option key={item} value={item}>
            {localeLabels[item]}
          </option>
        ))}
      </select>
    </label>
  );
}

export default LanguageSwitcher;
