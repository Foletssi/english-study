/* Eastudy V3 — 首页学习概览的边界.

   这块算的是"今天"和"本周", 而这两个词只有在时区定了之后才有意义.
   这些用例全部把 `now` 和时区显式传进去, 不读机器时钟 —— 否则一个在
   UTC 容器里跑的 CI 会在北京时间凌晨 8 点前后得到不同的结果, 而那种
   失败每周只出现几个小时, 排查起来最费时间. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const { summarize, summaryLine } = await import(pathToFileURL(join(root, 'src/student/summary.js')).href);

/* 2026-09-25 是周五. 北京时间 20:00 = UTC 12:00, 同一天, 所以用它做基准
   时"今天"在两种时区下都是 9 月 25 日, 便于先写下不涉及时区的断言. */
const FRI_EVENING = new Date('2026-09-25T12:00:00Z');

function row(iso, completed = false) {
  return { updated_at: iso, completed };
}

test('空输入返回全零,而不是抛错', () => {
  for (const input of [[], null, undefined]) {
    const result = summarize(input, FRI_EVENING);
    assert.deepEqual(result, { today: 0, week: 0, weekCompleted: 0, hasAny: false });
  }
});

test('今天与本周分别计数', () => {
  const rows = [
    row('2026-09-25T02:00:00Z'),           // 今天
    row('2026-09-25T01:00:00Z'),           // 今天
    row('2026-09-23T10:00:00Z'),           // 本周三
    row('2026-09-14T10:00:00Z'),           // 上周一,不算本周
  ];
  const result = summarize(rows, FRI_EVENING);
  assert.equal(result.today, 2);
  assert.equal(result.week, 3, '本周应含周一至今天,不含上周');
});

test('一周从周一开始,而不是周日', () => {
  /* 2026-09-20 是周日, 属于 9/14 那一周(周一起算); 9/21 是周一, 属于新的一周.
     如果哪天有人把周首改成周日, 这条会立刻红 —— 那正是要防的回归. */
  const rows = [row('2026-09-20T10:00:00Z'), row('2026-09-21T10:00:00Z')];
  const result = summarize(rows, FRI_EVENING);
  assert.equal(result.week, 1, '周日那条属于上一周,不该计入;周一那条才属于本周');
});

test('完成数只统计本周完成的', () => {
  const rows = [
    row('2026-09-24T10:00:00Z', true),     // 本周完成
    row('2026-09-25T02:00:00Z', true),     // 今天完成
    row('2026-09-10T10:00:00Z', true),     // 两周前完成,不该计入
    row('2026-09-24T11:00:00Z', false),    // 本周未完成
  ];
  const result = summarize(rows, FRI_EVENING);
  assert.equal(result.weekCompleted, 2);
  assert.equal(result.week, 3);
});

test('时区边界:深夜学的那条,按北京算昨天,按 UTC 会算成今天', () => {
  /* 学员在北京时间 9/25 23:00 看了一会儿(UTC 9/25 15:00), 第二天早上
     北京 9/26 07:30(UTC 9/25 23:30)打开首页.
     他心里的"昨天看的"和北京时区一致; UTC 会把这条算进"今天", 凭空多出 1.
     两个时区在这里必须给出不同答案 —— 如果哪天有人把时区写死成 UTC,
     这条是唯一会红的用例. */
  const beijingMorning = new Date('2026-09-25T23:30:00Z'); // 北京 9/26 07:30
  const rows = [row('2026-09-25T15:00:00Z')];              // 北京 9/25 23:00

  const inBeijing = summarize(rows, beijingMorning, 'Asia/Shanghai');
  const inUtc = summarize(rows, beijingMorning, 'UTC');

  assert.equal(inBeijing.today, 0, '按北京时区,这条是昨天夜里看的,不算今天');
  assert.equal(inUtc.today, 1, '按 UTC 时区会误算成今天 —— 所以默认时区不能是 UTC');
  // 本周计数不受这个边界影响,两边都该算上
  assert.equal(inBeijing.week, 1);
  assert.equal(inUtc.week, 1);
});

test('无法解析的时间戳不参与按日统计', () => {
  const rows = [row('不是时间'), row(undefined), row('2026-09-25T02:00:00Z')];
  const result = summarize(rows, FRI_EVENING);
  assert.equal(result.today, 1, '只有能解析的那一条算今天');
  assert.equal(result.hasAny, true, '有可解析的行时应标记为"有进度"');
});

test('有历史进度但本周没来:计数为 0,hasAny 为真', () => {
  const rows = [row('2026-08-01T10:00:00Z')];
  const result = summarize(rows, FRI_EVENING);
  assert.equal(result.today, 0);
  assert.equal(result.week, 0);
  assert.equal(result.hasAny, true, '老学员不该被当成新用户');
});

test('文案:没开始时说的是"还没开始",不是一个 0', () => {
  assert.equal(summaryLine({ today: 0, week: 0, weekCompleted: 0 }), '这周还没开始,挑一个看起来不难的就行。');
});

test('文案:今天动过时先报今天,再报本周', () => {
  const line = summaryLine({ today: 3, week: 7, weekCompleted: 2 });
  assert.equal(line, '今天动了 3 个 · 这周 7 个 · 完成 2 个');
});

test('文案:本週有进展但今天没有时不提今天', () => {
  assert.equal(summaryLine({ today: 0, week: 4, weekCompleted: 0 }), '这周 4 个');
});

test('文案:没有完成数时不显示"完成 0 个"', () => {
  const line = summaryLine({ today: 1, week: 1, weekCompleted: 0 });
  assert.equal(line, '今天动了 1 个 · 这周 1 个');
  assert.ok(!line.includes('完成'), '零完成不该出现在文案里');
});
