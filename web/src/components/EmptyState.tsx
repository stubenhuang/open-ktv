import type { ReactNode } from 'react';

/**
 * 空态：图标 + 标题 + 说明 + 可选操作。
 *
 * 替代原来光秃秃的一行灰字（「还没有作品。去伴奏库选一首……」）。
 * 空页面是用户对产品的第一印象之一，值得一个图标、一句人话和一个按钮。
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: string;
  title: string;
  description?: string;
  /** 操作按钮（通常是一个 Link 包着的 .btn） */
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon && (
        <div className="empty-state-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <div className="empty-state-title">{title}</div>
      {description && <div className="empty-state-desc">{description}</div>}
      {action && <div className="empty-state-actions">{action}</div>}
    </div>
  );
}
