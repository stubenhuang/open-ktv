import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * createDefaultRegistry 的装配规则。
 *
 * 这个文件**故意不做任何网络请求**：只验证「5sing 在不在、排第几、
 * 自建源还认不认、id 稳不稳」，全部是内存对象上的断言。
 */

import {
  createDefaultRegistry,
  createRegistry,
} from '../server/src/library/registry.ts';
import { FIVESING_ENABLED } from '../server/src/config.ts';

describe('createDefaultRegistry：默认装配', () => {
  it('默认带上内置 5sing，且排在最前', () => {
    const registry = createDefaultRegistry();
    assert.equal(registry.providers.length, 1);
    assert.equal(registry.providers[0]!.id, '5sing');
    assert.equal(registry.isEmpty, false);
  });

  it('includeFiveSing:false 时不带内置源', () => {
    assert.equal(createDefaultRegistry([], { includeFiveSing: false }).isEmpty, true);
  });

  it('LIBRARY_SOURCES 配的自建源照常加载，排在 5sing 后面', () => {
    const registry = createDefaultRegistry(['我的库=https://nas.local/ktv/index.json']);
    assert.equal(registry.providers.length, 2);
    assert.equal(registry.providers[0]!.id, '5sing');
    assert.equal(registry.providers[1]!.id, 'http-index:https://nas.local/ktv/index.json');
    assert.equal(registry.providers[1]!.label, '我的库');
  });

  it('5sing 的 id 与配置无关，点歌去重键稳定', () => {
    // 调整 LIBRARY_SOURCES 不该影响内置源的 id
    const a = createDefaultRegistry(['https://a.example/index.json']);
    const b = createDefaultRegistry(['https://b.example/index.json']);
    assert.equal(a.providers[0]!.id, b.providers[0]!.id);
    assert.ok(a.find('5sing'));
  });

  it('默认值跟随 FIVESING_ENABLED', () => {
    const registry = createDefaultRegistry();
    assert.equal(registry.providers.some((provider) => provider.id === '5sing'), FIVESING_ENABLED);
  });
});

describe('createRegistry：只装自建源（既有行为不变）', () => {
  it('空配置得到空注册表', () => {
    assert.equal(createRegistry([]).isEmpty, true);
  });

  it('坏配置项被跳过，其余照常', () => {
    const registry = createRegistry(['不是一个地址', 'https://ok.example/index.json']);
    assert.equal(registry.providers.length, 1);
  });
});
