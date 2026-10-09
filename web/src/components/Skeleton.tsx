/**
 * 骨架屏：列表/卡片加载中的占位。
 *
 * 为什么不用「正在加载…」：一行灰字告诉不了用户「内容长什么样、还要等多久」，
 * 骨架屏给出「就快好了，布局不会跳」的预期。微光动画走 CSS（transform 平移
 * 伪元素），不触发重排；reduced-motion 下自动停（styles.css 全局查询）。
 */

/** 伴奏列表的骨架行（与 .track-item 等高，替换时页面不跳） */
export function TrackSkeletonList({ count = 4 }: { count?: number }) {
  return (
    <div className="track-list">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="skeleton skeleton-track" />
      ))}
    </div>
  );
}

/** 作品库网格的骨架卡（封面 + 标题 + 播放器 + 操作行的高度） */
export function WorkSkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="work-list">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="skeleton skeleton-card" />
      ))}
    </div>
  );
}
