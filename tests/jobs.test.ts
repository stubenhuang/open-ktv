import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { enqueue, getProgress, isQueued, queueState } from '../server/src/jobs.ts';

/** 包一层 enqueue，任务结束（成功或失败）时 resolve，方便测试等待 */
function runTask(
  key: string,
  task: (report: (ratio: number) => void) => Promise<void>,
): Promise<Error | null> {
  return new Promise((resolve) => {
    enqueue(
      key,
      async (report) => {
        try {
          await task(report);
          resolve(null);
        } catch (error) {
          resolve(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      },
      (error) => resolve(error),
    );
  });
}

describe('任务队列', () => {
  it('任务串行执行，按入队顺序', async () => {
    const events: string[] = [];

    await Promise.all([
      runTask('serial:a', async () => {
        events.push('a:start');
        await new Promise((resolve) => setTimeout(resolve, 30));
        events.push('a:end');
      }),
      runTask('serial:b', async () => {
        events.push('b:start');
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push('b:end');
      }),
    ]);

    assert.deepEqual(events, ['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('isQueued：排队中和运行中为 true，结束后 false', async () => {
    let release = () => {};
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });

    const blockerDone = runTask('queued:blocker', () => blocker);
    const secondDone = runTask('queued:second', async () => {});

    // enqueue 是 setImmediate 里才启动队列的，先让出一轮事件循环
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 此时 blocker 在跑、second 在排队
    assert.equal(isQueued('queued:blocker'), true);
    assert.equal(isQueued('queued:second'), true);
    assert.equal(isQueued('queued:none'), false);
    assert.deepEqual(queueState(), { active: 'queued:blocker', waiting: 1 });

    release();
    await Promise.all([blockerDone, secondDone]);
    // 队列的 finally 里才清 active，再让出一轮
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(isQueued('queued:blocker'), false);
    assert.equal(isQueued('queued:second'), false);
    assert.equal(queueState().active, null);
    assert.equal(queueState().waiting, 0);
  });

  it('进度被钳制在 0–1，未知 key 返回 null', async () => {
    let seen = 0;
    await runTask('progress:a', async (report) => {
      report(0.5);
      seen = getProgress('progress:a')!;
      report(2);
      assert.equal(getProgress('progress:a'), 1, '上限钳到 1');
      report(-1);
      assert.equal(getProgress('progress:a'), 0, '下限钳到 0');
    });

    assert.equal(seen, 0.5);
    assert.equal(getProgress('progress:unknown'), null);
  });

  it('enqueue 会把进度重置为 0', async () => {
    await runTask('reset:a', async (report) => report(0.7));
    assert.equal(getProgress('reset:a'), 0.7);

    await runTask('reset:a', async () => {
      // 任务刚开始时进度应已被重置（这个任务自己不报进度）
      assert.equal(getProgress('reset:a'), 0);
    });
  });

  it('任务抛错时 onError 收到 Error，队列继续跑后续任务', async () => {
    const finished: string[] = [];
    const boom = new Error('炸了');

    const failed = runTask('err:a', async () => {
      throw boom;
    });
    const ok = runTask('err:b', async () => {
      finished.push('b');
    });

    const [firstError] = await Promise.all([failed, ok]);

    assert.equal(firstError, boom, 'onError 拿到的是原 error 对象');
    assert.deepEqual(finished, ['b'], '失败不阻塞后面的任务');
  });

  it('非 Error 的抛出也被归一成 Error', async () => {
    const failure = await runTask('err:string', async () => {
      throw '字符串错误'; // NOSONAR: 故意测脏数据
    });
    assert.ok(failure instanceof Error);
    assert.equal(failure!.message, '字符串错误');
  });
});
