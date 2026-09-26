/* 提示词 (AI 指令) 的契约测试。

   同一份指令有两个读者, 在两个不同的运行时里:

     - 控制端 (JS, `src/admin/prompts.js` -> esbuild 打进 bundle)
     - worker (Python, `services/worker/prompts.py` -> 启动时读盘)

   两边读的是同一个 `prompts/prompts.json`。这个文件测的就是"同一份"这件事,
   以及那份文件本身是不是可用。

   为什么值得单独测: 这几条都不会以报错的形式表现出来。

   1. 正文被抄回 `src/admin/prompts.js`。有人图省事把字符串粘回去, 于是控制台
      展示 A 版、worker 跑 B 版, 两边都是合理的中文, 没有任何一处会报错。运维
      对着一版质量不佳的产出判断"指令写得不好", 而他看的那版根本没在跑。

   2. 缺少 id。worker 按 id 取 (`prompt_text("enrich")`), 少一条要到流水线跑
      到那一步才炸, 而那时已经付过 ASR 的钱了。

   3. `id` 重复。取到的是另一条指令 —— 也是两份合理的中文, 肉眼对不出来。

   4. 版本号没跟着正文升。产物里写着 `prompt_version`, 但那个号已经不指向任何
      真实存在的指令版本, 追溯就成了假的。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const FILE = join(root, 'prompts', 'prompts.json');
const JS_READER = join(root, 'src', 'admin', 'prompts.js');
const PY_READER = join(root, 'services', 'worker', 'prompts.py');

/** 四个 id 是这份文件的契约, 三个 reader 都要认。worker 侧用 transcribe /
    enrich, 控制端四条都展示 —— 少哪一条都要在这里发现。 */
const REQUIRED_IDS = ['preraw', 'transcribe', 'enrich', 'audit'];

const raw = readFileSync(FILE, 'utf8');
const file = JSON.parse(raw);

test('prompts.json 结构可用', () => {
  assert.match(file.version, /^\d+\.\d+\.\d+$/, 'version 必须是 x.y.z');
  assert.ok(Array.isArray(file.prompts) && file.prompts.length > 0, 'prompts 不能为空');

  for (const item of file.prompts) {
    assert.equal(typeof item.id, 'string', '每条都要有 id');
    assert.ok(item.id.trim(), 'id 不能是空串');
    // 控制端设置页要渲染这三项; 缺了页面上就是一片空白, 而不会报错。
    assert.ok(item.name?.trim(), `${item.id}: 缺 name`);
    assert.ok(item.stage?.trim(), `${item.id}: 缺 stage`);
    assert.ok(item.input?.trim(), `${item.id}: 缺 input`);
    assert.ok(item.output?.trim(), `${item.id}: 缺 output`);
  }

  const ids = file.prompts.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, 'id 不能重复');
  for (const id of REQUIRED_IDS) {
    assert.ok(ids.includes(id), `缺提示词: ${id}`);
  }
});

test('每条指令的正文非空, 并且要求 JSON 输出', () => {
  for (const item of file.prompts) {
    assert.ok(item.text?.trim(), `${item.id}: 正文不能为空`);

    // 空正文比错正文更危险: 模型收到空 system 消息会自由发挥, 产出结构仍然
    // 合法, 于是流水线一路跑到发布 —— 日志里一个错都没有。
    //
    // 正文是一句面向模型的话, 只有几十个字符时几乎肯定是没写完 (或者被误
    // 截断)。这里用一个保守的下限, 不测质量, 只测"是不是真的填了东西"。
    assert.ok(item.text.trim().length > 200, `${item.id}: 正文只有 ${item.text.trim().length} 字, 疑似未写完`);

    // 全部四条都走 JSON 模式 (ai.py 里发 response_format=json_object), 正文
    // 里必须把"只输出 JSON"写清楚, 否则模型会在 JSON 外面裹一层解释文字,
    // 解析当场失败。
    assert.match(item.text, /只输出 JSON/, `${item.id}: 正文必须明确要求只输出 JSON`);
  }
});

test('正文没有躲在 JS 或 Python reader 里', () => {
  /* 这条是这个文件存在的主要理由。转发层里不该出现指令正文的任何一段 ——
     一旦出现, 就说明有人把字符串抄了回去, 而那份抄来的副本会静静地和真源
     分家。

     检测方式是取正文里最长的一段连续文字当指纹: 正文里的换行是 `\n` 转义,
     所以指纹里不能带换行。长到 40 字符的连续中文/英文片段, 如果 reader 里
     出现了, 那不可能是巧合。 */
  const jsSource = readFileSync(JS_READER, 'utf8');
  const pySource = readFileSync(PY_READER, 'utf8');

  for (const item of file.prompts) {
    const chunks = item.text.split('\n').map((line) => line.trim()).filter((line) => line.length >= 40);
    for (const chunk of chunks) {
      assert.ok(
        !jsSource.includes(chunk),
        `${item.id}: src/admin/prompts.js 里出现了指令正文 —— 真源只能是 prompts/prompts.json`,
      );
      assert.ok(
        !pySource.includes(chunk),
        `${item.id}: services/worker/prompts.py 里出现了指令正文 —— 真源只能是 prompts/prompts.json`,
      );
    }
  }
});

test('两个 reader 都指向同一个文件, 且认同一批 id', () => {
  const jsSource = readFileSync(JS_READER, 'utf8');
  const pySource = readFileSync(PY_READER, 'utf8');

  // JS: 相对的 JSON 导入。路径写错的话 esbuild 会报错, 但那是构建期才发现的
  // (而且 `npm run test` 在没有 build 的机器上跑得通)。这里提前抓住。
  assert.match(jsSource, /from '\.\.\/\.\.\/prompts\/prompts\.json'/, 'JS reader 必须读 ../../prompts/prompts.json');

  // Python: 按 __file__ 算路径, 不依赖工作目录。
  assert.match(pySource, /"prompts"\s*\/\s*"prompts\.json"/, 'Python reader 必须指向 prompts/prompts.json');

  // 两个 reader 都要求这四个 id 存在。JS 那边是解构导出, 少一个就是 undefined,
  // 而 undefined 传给 fetch 会在运行时变成一个没有 system 消息的请求。
  for (const id of REQUIRED_IDS) {
    assert.ok(jsSource.includes(`${id}:`), `JS reader 少了 ${id} 的导出`);
    assert.ok(pySource.includes(`"${id}"`), `Python reader 少了 ${id}`);
  }
});

test('settings 表的 key 两边一致', () => {
  /* worker 从 settings 表读 AI 配置 (services/worker/config.py:SETTINGS_KEY),
     控制端往同一张表写 (functions/api/admin/settings/ai.js:CONFIG_KEY)。两边
     都是字符串字面量 `'ai'`, 拼错任一边都不会报错 —— 只会表现为"设置页填了
     但不生效", 而那正好是这次要修的那个 bug 的症状, 没人会怀疑是拼写。 */
  const jsSource = readFileSync(join(root, 'functions', 'api', 'admin', 'settings', 'ai.js'), 'utf8');
  const pySource = readFileSync(join(root, 'services', 'worker', 'config.py'), 'utf8');

  const jsKey = jsSource.match(/CONFIG_KEY\s*=\s*'([^']+)'/);
  const pyKey = pySource.match(/SETTINGS_KEY\s*=\s*"([^"]+)"/);
  assert.ok(jsKey, "settings/ai.js 里找不到 CONFIG_KEY");
  assert.ok(pyKey, 'config.py 里找不到 SETTINGS_KEY');
  assert.equal(pyKey[1], jsKey[1], 'worker 读的 settings key 必须和控制端写的一致');
});
