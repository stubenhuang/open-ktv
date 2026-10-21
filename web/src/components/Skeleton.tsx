//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 stubenhuang

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

/**
 * 作品库的骨架行：和 .work-row 同形（封条 + 播放键 + 两行字），
 * 换真数据时行高一致，页面不跳。
 */
export function WorkSkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="work-list">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="work-row work-row-skeleton" aria-hidden="true">
          <div className="skeleton work-row-skeleton-cover" />
          <div className="skeleton work-row-skeleton-play" />
          <div className="work-row-main">
            <div className="skeleton skeleton-line" style={{ width: '42%' }} />
            <div className="skeleton skeleton-line is-short" />
          </div>
        </div>
      ))}
    </div>
  );
}
