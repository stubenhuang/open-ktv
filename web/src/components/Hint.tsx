/**
 * 悬停说明：一个小图标挂在标签旁，鼠标移上去（或键盘聚焦）才展开解释文字。
 *
 * 为什么需要它：作品编辑页要求「所有元素一屏放完、不滚动」，而每个控件都常驻
 * 一行说明会把面板撑出两屏。说明并没有被删掉 —— 只是从「常驻」变成「按需」，
 * 想看的用户移下鼠标就有，不想看的用户眼里只剩控件。
 *
 * 两种语气（tone）：
 *  · info（默认）—— 这个控件是干什么的；
 *  · warn         —— 试听与成品行为不一致、或者容易误用的地方（颜色更醒目）。
 *
 * 展开方向（placement）：
 *  · right（默认）—— 朝右展开。图标一律挂在标签左侧，右边永远有地方；
 *  · left          —— 朝左展开。给双列排版下落在右半列的控件用；
 *  · top           —— 朝上展开。给贴视口底部的控件用（朝右展开会掉出视口，
 *                     而 visibility:hidden 的绝对定位气泡照样算进文档滚动高度，
 *                     会把「一屏放完」撑破）。
 *
 * flipNarrow：窄屏（<760px，混音面板回落单列）时把 left 改回 right ——
 * 单列下所有图标都回到页面左侧，朝左展开反而会跑出视口。
 *
 * 可访问性：图标是真正的 <button>，能 Tab 聚焦、触屏点一下也能唤出（:focus-within）；
 * 全文同时写进 aria-label，读屏用户不依赖悬停。气泡本身 aria-hidden，避免重复朗读。
 * 零 state、零依赖 —— 显隐全靠 CSS。
 */
export function Hint({
  text,
  tone = 'info',
  placement = 'right',
  flipNarrow = false,
}: {
  /** 气泡里的说明全文（同时是图标的 aria-label） */
  text: string;
  tone?: 'info' | 'warn';
  placement?: 'right' | 'left' | 'top';
  /** 窄屏单列排版时把展开方向翻回朝右 */
  flipNarrow?: boolean;
}) {
  return (
    <span
      className={`hint hint-${tone}`}
      data-placement={placement}
      data-flip-narrow={flipNarrow ? '1' : undefined}
    >
      <button type="button" className="hint-icon" aria-label={text}>
        {/* 字形只是视觉提示，读屏读的是按钮上的 aria-label */}
        <span aria-hidden="true">{tone === 'warn' ? '!' : 'i'}</span>
      </button>
      <span className="hint-bubble" aria-hidden="true">
        {text}
      </span>
    </span>
  );
}
