/**
 * 数值解析与钳制（纯函数）。
 *
 * 服务端做请求参数消毒、前端做输入归一化时都要这套语义：
 * 解析不出数字就用「上一个有效值」（fallback），而不是悄悄变成 0 ——
 * 把用户的 -3 静默改成 0 比报错更难查。
 */

/** 解析成数字并夹在 [min, max]；非有限数回落 fallback（不取整） */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

/** 同 clampNumber，但四舍五入到整数 */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}
