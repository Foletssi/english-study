/* Eastudy V3 — 教学内容生成的 AI 指令 (提示词) —— **只读转发层**。

   ---------------------------------------------------------------------------
   真源不在这个文件里

   指令的正文、版本号、每条的中文名和输入输出说明, 全部住在
   `prompts/prompts.json`。这个文件只做两件事: 把它转成 ES 模块导出, 并给
   `promptById()` 一个会抛错的查表。

   ---------------------------------------------------------------------------
   为什么必须只有一份

   同一份指令有两个读者, 而它们在不同的运行时里:

     - 控制端设置页 —— 运维要看"现在跑的是第几版、内容是什么"。它是证据。
     - `services/worker` (Python) —— 真正把指令发给 DeepSeek 的是它。

   以前这两边各存一份, 差一点就上线。那种分家的坏处不是"要改两处"这么轻:
   控制台上展示的那份会变成**装饰** —— 运维对着一版指令判断质量, 而模型
   跑的是另一版, 于是他所有的判断都建立在错的前提上。而且两边都是"看起来
   正常"的文本, 没有任何一处会报错。

   所以 Python 侧也读同一个文件 (services/worker/prompts.py), 版本号是两边
   的契约。`tests/unit/prompts.test.mjs` 会断言正文不出现在这个文件里 ——
   防止有人图省事又把字符串抄回来。

   ---------------------------------------------------------------------------
   两条指令对应流水线里两次调用, 目标相反, 所以必须分开

     transcription(转写)  —— 输入是原片的**音频**。目标是"忠实": 把听到的
         写下来。不该出现润色、不该合并短句、不该纠正说话人的口误。一条被
         "优化"过的字幕会让学员在视频里找不到对应的那句话。
     enrichment(教研)    —— 输入是**已经定稿的字幕**。目标正好相反: 要提炼、
         归纳、取舍 —— 挑出值得教的词、给出释义、写语境说明。

   把这两件事塞进同一条指令是这类项目最常见的错误。用一条"既要忠实转写又
   要输出教学内容"的指令, 模型会为了"看起来有用"而改写转写结果, 而转写结果
   是要跟时间轴对齐的, 改写就等于错位。

   ---------------------------------------------------------------------------
   改了 prompts/prompts.json 的正文, **必须**同时升里面的 version

   语义化: 改措辞 -> +patch, 改输出字段 -> +minor, 改任务目标 -> +major。
   版本号会写进每次生成的结果里, 这样一条教学材料质量不对时, 能查到它是哪
   一版指令产出的。`npm run check` 里的测试会拦住"改了正文忘升版本号"以外的
   结构问题: 缺字段、正文为空、id 重复。 */

import promptsFile from '../../prompts/prompts.json' with { type: 'json' };

/** 版本号。跟 `prompts/prompts.json` 的 `version` 是同一个值 —— 不是抄来的,
    是读来的, 所以不存在"两个版本号对不上"这种状态。 */
export const PROMPT_VERSION = promptsFile.version;

/** 一份目录。控制端按这个渲染, worker 按 id 取用。

    冻结: 这份对象在模块加载时构造一次, 控制端直接把它渲染出来。如果它是
    可变的, 某一页不小心改了一个字段, 别的页面读到的就是被改过的值 —— 而
    这种 bug 的症状是"某个页面显示不对", 查起来要绕很久。 */
export const PROMPTS = Object.freeze(
  promptsFile.prompts.map((item) => Object.freeze({ ...item })),
);

/* 按 id 建索引, 顺便在加载期就把重复的 id 找出来。重复 id 的症状是"取到的是
   另一条指令", 而两条都是合理的中文文本, 肉眼对不出来。 */
const BY_ID = new Map();
for (const item of PROMPTS) {
  if (BY_ID.has(item.id)) throw new Error(`prompts.json 里 id 重复: ${item.id}`);
  BY_ID.set(item.id, item);
}

/** 按 id 取一条指令。找不到时抛错而不是返回空字符串 —— 空指令会让这一步
    静默地退化成"让模型自由发挥", 产出的东西看起来正常但完全不可控。 */
export function promptById(id) {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`未知的提示词: ${id}`);
  return found;
}

/** 四条指令都取出来, 按 id 命名。比记住字符串字面量安全 —— 拼错 id 会在
    这里抛错, 而不是在流水线跑到那一步时才发现。 */
export const {
  preraw: PRERAW_SYSTEM_PROMPT,
  transcribe: TRANSCRIBE_SYSTEM_PROMPT,
  enrich: ENRICH_SYSTEM_PROMPT,
  audit: AUDIT_SYSTEM_PROMPT,
} = Object.fromEntries(PROMPTS.map((item) => [item.id, item.text]));
