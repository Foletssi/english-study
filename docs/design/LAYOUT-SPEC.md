# Eastudy V3 排版布局规范（四屏）

> 配套文件：[wireframes.html](./wireframes.html) — 四个屏幕的标注图（在浏览器里打开，红圈数字对应图例）。
>
> 本文件的数值全部来自 `public/assets/tokens.css` 与 `public/assets/app.css`。对不上时以那两个文件为准，回来改这里。

---

## 一、先定画布

四屏指的是三块画布 × 两种内容：

| 编号 | 画布 | 尺寸 | 断点 | 说明 |
|---|---|---|---|---|
| S1 | 网页端 · 内容页 | 1440 × 900（设计稿） | > 1080px | 顶栏常驻横向导航 |
| S2 | 网页端 · 播放器 | 1440 × 900（设计稿） | > 1080px | 左主区 + 右 280px 侧栏 |
| S3 | 移动端 · 内容页 | 390 × 844（iPhone 14/15） | ≤ 860px | 导航换到底部标签栏 |
| S4 | 移动端 · 播放器 | 390 × 844 | ≤ 860px | 同上，播放器内两列塌成一列 |

**"移动端播放器"和"移动端适配播放器"是同一屏的两种状态**，出图时给两张：

- **S4a 竖屏**：390 × 844 —— 就是上表那一条。
- **S4b 全屏/横屏**：844 × 390 —— 视频铺满，字幕叠在视频底部，控制条压在字幕下方。**这一屏目前代码里没有专门做**（用的是浏览器原生全屏），出图时按"沉浸式"处理即可，不必迁就现有实现。

设计稿建议 1440 宽而不是实际最大宽度 1240：1240 是内容区的上限，两侧留白是壳自己的事。

---

## 二、全局尺度

**间距**（全部是 4 的倍数，别引入新值）

```
4 · 8 · 12 · 16 · 22 · 30 · 42 · 58      →  --space-1 … --space-8
```

**圆角**

```
6 小标签 · 9 次级块 · 13 按钮/输入框 · 18 卡片 · 26 大容器 · 999 胶囊
```

**字号**

```
12 辅助 · 13 次要 · 15 正文 · 17 卡片标题 · 21 页面副标题/播放器标题 · 27 区块标题 · 34 页面主标题
```

**字体**

- 界面：Inter + 苹方 + 微软雅黑
- 正文阅读（字幕）：Source Serif 4 + 宋体 — **字幕用衬线是刻意的**，长句连读时字形差异比无衬线更容易分辨
- 时间码 / 音标 / 快捷键：等宽（SFMono / JetBrains Mono / Consolas）

**触控**

- 所有可点区域最小 **44 × 44**，包括看起来只有 20px 的图标按钮——44 是内边距撑出来的，不是图标撑出来的。

**主色（雾蓝）**

```
主色      #346DA5      主色深   #275A8C      主色浅底 #E8F1FA
品牌墨蓝  #17263D      深蓝     #1B4670
页面底    #F7F9FC      卡片面   #FFFFFF      下沉底   #EEF3F9
正文      #17263D      次要     #536983      最弱     #7F93A8
描边      #DCE5EF      强描边   #C3D2E2
教学释义  #8A5A1E（褐）  释义下划线 #C08A3E
生词高亮底 rgba(52,109,165,.16)   关键挖空底 #FBE9C9
成功 #0F7A5A   警告 #976222   危险 #C0392B   信息 #1D4FD7
VIP 底 #E7F0FD    VIP 字 #1E4E8C
```

**三套主题**：浅色（默认）／深色／夜间暖色。暖色调的是**色温**不是亮度——出图时暖色的底色应是暖灰褐（`#1E1814` 一档），不是把深色主题调暗一档。

---

## 三、顶栏（四屏共用，位置固定）

高度 **58px**，吸顶，底部一条 1px 描边。

### 左区

| 序号 | 元素 | 尺寸 | 位置 |
|---|---|---|---|
| 1 | Logo 方块（字母 E） | 28 × 28，圆角 13px | 距左 16px（移动端 12px） |
| 2 | 品牌名 "Eastudy" | 15px / 600 | 紧随 Logo 右侧 8px |
| 3 | 横向导航 5 项 | 每项 padding 8×14px，项间 2px | 紧随品牌名右侧（移动端**整块隐藏**） |

导航五项固定顺序：**首页 · 视频库 · 计划 · 词汇 · 我的**。当前项＝主色文字 + 主色浅底。

### 右区（`margin-left: auto`，靠右）

**这四个的顺序不许改**：搜索 → VIP → 主题 → 头像。

| 序号 | 元素 | 尺寸 | 备注 |
|---|---|---|---|
| 4 | 搜索 | 44 × 44，放大镜线性图标 20px | |
| 5 | VIP 徽标 | padding 2×8px，全圆角，12px/600 | **只在会员身上出现**，非会员这一格整个消失（不留空位） |
| 6 | 主题 | 44 × 44，图标 20px | 三态：☀ 太阳＝浅色 / ☾ 月亮＝深色 / 烛火＝暖色 |
| 7 | 头像 | 32 × 32 圆形，昵称首字，13px/600 | 距右边缘 16px（移动端 12px） |

> 主题按钮的三颗图标**必须一眼能分清**。用"两个月亮、一个蓝一个橙"来表示深色和暖色是失败的——用户得先记住哪个是哪个。所以暖色用**烛火**，形状本身就不一样。

---

## 四、S1 网页端内容页

```
┌──────── 顶栏 58px ────────┐
│                           │
│  主标题 34px              │   ← 进度概览条：一句话说"今天/这周动过没有"
│  副标题 15px 次要         │      没有任何记录时整条不画
│                           │
│  ┌──── 继续学习主卡 18px 圆角 ────┐
│  │ ┌────────┐  继续学习（小字）   │
│  │ │ 16:9   │  Unit 3 …  21px    │
│  │ │ 缩略图 │  已学 46% · 6:12   │
│  │ │   ▶    │  ▰▰▰▰▱▱▱ 6px 进度 │
│  │ └────────┘        [继续播放]  │
│  └────────────────────────────────┘
│  ┌ 小入口 ┐ ┌ 小入口 ┐            ← 降级的另外两个，一行
│                           │
│  ┌────┐┌────┐┌────┐┌────┐        ← 视频卡片四列，最小 240px
│  │16:9││16:9││16:9││16:9│          卡片圆角 18px，封面 16:9
│  │标题││标题││标题││标题│          底部 3px 进度条
│  └────┘└────┘└────┘└────┘
└───────────────────────────┘
```

- 内容区左右内边距 16px，上 22px，下 42px，**居中，最大宽度 1240px**。
- **首页没有推荐位。** 老版本四个轮播（热门标签/热门合集/推荐博主/推荐视频）是产品决策删掉的，不是漏了。回来的用户要的是"我上次那个"，不是"你可能喜欢"。
- **主卡只提一张。** 三张等宽卡片把"最近那一个"和"另外两个"摆成同一档，而首页上真正有信息量的只有最近那一个；剩下两张降级成一行小入口，决策成本从"选一个"降到"点下去"。
- 视频卡片：封面 16:9 → 标题（最多两行截断）→ 副标题（一行截断）→ 元信息行（难度胶囊 + 等宽时长 + 「已完成」标记）→ 未看完时底部 3px 主色进度条。
- 骨架屏卡片固定高 210px，8 张。

**响应式**：> 1080px 四列；860–1080px 三列；640–860px 两列；≤ 640px 两列且间距从 16px 收到 12px。

---

## 五、S2 网页端播放器

主结构：**左主区（自适应） + 右侧栏（280px）**，两者间距 22px。

### 播放器内部（自上而下）

1. **视频舞台** — 16:9，圆角 18px，**永远黑底**。这条不受主题影响：浅色页面上，明亮的视频画面旁边再放浅色背景，字幕会糊掉；而且教学用的褐色/雾蓝标注是照着深底调的。
2. **标题 21px + 副标题 13px 次要色**。
3. **进度条** — 高 8px 全圆角，底层下沉灰，中间缓冲层强描边灰，上层主色填充。拖拽圆点 14px（白底 + 3px 主色描边），**只在悬停/键盘聚焦时显形**。
4. **控制条** — 一行，`gap: 6px`：

```
[« 后退]  [▶ 播放]  [» 前进]   6:12 / 13:40          ←—— 弹性空隙 ——→   [1x][单句循环][跟读][盲听][挖空]
   44×44      44×44     44×44     等宽 12px                                   胶囊 6×12px
```

   左边四件是一组，右边五颗胶囊是另一组，中间靠 `flex: 1` 的空隙顶开。**别把它们排成等距**——等距之后播放键就不再是焦点。

5. **正文区** — 两列：字幕流（自适应） + 生词卡（300px 固定），间距 16px：

   - **字幕流**：时间列 52px + 正文列，行内 padding 10×12px。**最高 420px，超出滚动**。当前句主色浅底 + 主色左边缘标记。英文 15px / 行高 1.75（衬线），中文翻译 12px 次要色另起一行。
   - **生词卡**：圆角 18px，白底。词形 21px/600 → 音标等宽 12px → 释义 13px → 例句 12px 次要色 → 来源（左侧 2px 竖线 + "出现在 0:11"）→ 两颗胶囊按钮。**滚动时吸附在顶栏下方。**

6. **接下来看** — 四张横排卡片，每张 13px 标题 + 12px 提示（"下一课" / "已学 82%" / "未开始"）。

### 右侧栏（280px）

两张卡片，也吸附：**本课信息**（难度 / 分类 / 学习进度三行）→ **快捷键**（空格 / ← / →）。

### 特殊状态

- **盲听**打开：字幕的英文和中文一起 `visibility: hidden`——**保留占位不塌陷**，否则开关一按整页跳一下。
- **挖空**打开：关键词变成"透明文字 + 下沉底"，也就是一坨灰块，长度还看得见——这是给回忆留的形状提示。
- **单句循环**打开：当前句高亮，播放到头自动跳回句首。

**响应式**：≤ 1080px 时右侧栏和生词卡都取消吸附并塌成单列，播放器正文也收成一列；≤ 860px 顶栏导航换底部标签栏（见 S3/S4）。

---

## 六、S3 移动端内容页

- 顶栏只留 **Logo + 右区四件**，横向导航整块消失，品牌名也消失（宽度不够，先砍文字再砍功能）。
- 内容区左右内边距收到 12px，**底部留 92px**——56 给标签栏，剩下是安全区。
- 主标题从 34px 降到 21px。
- 继续学习主卡：单列堆叠——缩略图在上，正文在下。
- 视频卡片两列，最小 160px，间距 12px。

**底部标签栏**（固定贴底，`z-index: 50`）：

```
┌──────┬──────┬──────┬──────┬──────┐
│  ⌂   │  ▤   │  ◷   │  ▤   │  ☺   │   ← 线性图标 22px，描边取 currentColor
│ 首页 │视频库│ 计划 │ 词汇 │ 我的 │   ← 10px 文字
└──────┴──────┴──────┴──────┴──────┘
         ↑ 每项最小高 52px，5 等分，当前项主色
```

下沿要叠 `env(safe-area-inset-bottom)`，否则 iPhone 上最后一行被 Home 条压住。

---

## 七、S4 移动端播放器

- 视频舞台仍 16:9，圆角 18px。
- **控制条允许换行**：主控三颗 + 时间码占第一行，五颗胶囊折到第二行左对齐。这是窄屏下唯一体面的排法——五个胶囊强行挤一行，每颗都会被压到读不清。
- **播放器内部两列塌成一列**：字幕流在上、生词卡在下（生词卡不再吸附、宽度 100%）。
- 字幕流最高仍是 420px，超出滚动。
- 标签栏保持在最底部，播放中「视频库」项高亮。

### S4b 横屏/全屏（沉浸态）

```
┌──────────────────────────────────────┐
│                                      │
│            视频铺满                  │
│                                      │
│                                      │
│   She has already finished her…      │ ← 字幕叠在底部居中，半透明黑底
│   她已经写完作业了。                  │
│ ─────────────●────────────────────── │ ← 进度条贴在字幕下方
│  «    ▶    »   6:12/13:40     1x …   │ ← 控制条再下面，可自动隐藏
└──────────────────────────────────────┘
```

三件东西自下而上叠：控制条 → 进度条 → 字幕。**点任意处唤出/收起控制层。**这一屏目前代码里走的是浏览器原生全屏，样式不归我们管；出图按上面的沉浸式处理就行。

---

## 八、图标清单（形状与语义）

统一 **24 × 24 网格、2px 描边、圆角端点、线性**。**只有播放键是实心**——混用实心和线框，某颗会在 18px 下糊成一团，或者看起来比别的重。

| 名字 | 形状 | 用在哪 |
|---|---|---|
| home | 屋顶 + 屋身 | 标签栏·首页 |
| library | 两块并排矩形（左右各一） | 标签栏·视频库 |
| plan | 钟面 + 指针 | 标签栏·计划 |
| vocabulary | 人形 + 右侧三条横线 | 标签栏·词汇 |
| account | 头 + 肩 | 标签栏·我的 |
| search | 放大镜（圆 + 斜柄） | 顶栏搜索 |
| sun | 圆心 + 八条放射线 | 主题·浅色 |
| moon | 月牙（缺右） | 主题·深色 |
| flame | 烛火（内焰外焰两层） | 主题·暖色 |
| play | 实心三角 ▶ | 播放键、缩略图覆盖层 |
| arrowLeft | 单个左尖括号 | 后退 5 秒 |
| arrowRight | 单个右尖括号 | 前进 5 秒 |

**现在的不一致**：播放器那三颗（后退/播放/前进）代码里还是**字符字形**（`« ▶ »`），标签栏已经换成上面这套线性图标了。字符的问题不是好不好看，是它根本不受控——字体没覆盖就回退到系统字体，同一个页面在 Windows、macOS、安卓上长成三种样子，18px 的 `✎` 在安卓偏下两像素、在 iPhone 偏上。

**出图时请一律按线性图标画**，代码这边会跟上。

---

## 九、AI 出图指令

下面的指令按**每屏一段**给。一次性把四屏塞进一段，模型会在第四屏开始偷工减料。

### 中文版（给 ChatGPT / image 2.5）

**S1**

> 输出一张**高保真 UI 设计稿**，1440 × 900，网页端教育视频网站的内容页。
>
> 顶部 58px 高白色导航栏，底边一条 1px 浅灰描边。左起：一个 28×28 圆角方块 Logo（内含白色字母 E，底色 `#346DA5`），旁边品牌名 "Eastudy"；再往右是五个横向导航项「首页 视频库 计划 词汇 我的」，当前项「首页」为 `#346DA5` 文字配 `#E8F1FA` 浅底圆角胶囊。导航栏最右侧靠边依次是四个元素：44×44 的放大镜线性图标按钮、一个蓝色 VIP 小徽标、一个 44×44 的太阳线性图标按钮、一个 32×32 圆形头像（浅蓝底、深蓝文字「林」）。
>
> 下方内容区居中，最大宽 1240px，页面底色 `#F7F9FC`。第一行是 34px 深蓝黑主标题「早上好，林同学」，下面 15px 灰色副标题。接着一条浅色信息条，写「今天学了 2 个视频，本周 5 个」。
>
> 再往下是一张大卡片（白底、18px 圆角、1px `#DCE5EF` 描边、16px 内边距）：左侧 320px 宽 16:9 缩略图（圆角 13px，中央一个 46px 白色半透明圆形播放按钮，内含深色实心三角）；右侧是「继续学习」小标签、21px 加粗标题「Unit 3 — 现在完成时」、13px 灰色「已学 46% · 上次看到 6:12」、一条 6px 高圆角进度条（46% 填充 `#346DA5`），右下角一个实心 `#346DA5` 圆角按钮「继续播放」。
>
> 大卡片下方一行两个浅色小入口，各写一个课程名和一个进度百分比。
>
> 再下方是 4 列视频卡片网格，间距 16px。每张卡：白底、18px 圆角、1px 描边；上部 16:9 封面图（用宁静的抽象渐变色块代替照片）；下部 12px 内边距，依次是 15px 加粗标题、12px 灰色副标题、一行「中级」小胶囊 + 等宽字体时长，其中一张卡底部多一条 3px 主色进度条。
>
> 风格：干净、克制、大量留白，圆角柔和，阴影极浅，无任何装饰性插画，无 3D，无渐变滥用。中文界面。字体用无衬线（思源黑体/苹方一类的观感）。
>
> **位置必须严格照上面写的次序，不要自行增删图标，不要改变顶栏右侧四个元素的顺序。**

**S2**

> 同上风格，1440 × 900，网页端**视频播放页**。
>
> 顶栏完全相同（只是当前导航项改成「视频库」高亮）。下方分两列：左侧自适应主区，右侧 280px 固定侧栏（滚动吸附），列间距 22px。
>
> 左主区自上而下：
> 1. 一个 16:9 的**纯黑视频区**，圆角 18px，画面用深色电影感的抽象场景填充。
> 2. 21px 加粗标题「Unit 3 — 现在完成时」和 13px 灰色副标题「中考语法精讲 · 中级」。
> 3. 一条 8px 高全圆角进度条：底层浅灰、中段深一点的缓冲色、前段 `#346DA5` 填充，前端有个 14px 白色圆点（3px `#346DA5` 描边）。
> 4. **控制条**，从左依次：44×44 的后退图标按钮（单个左尖括号）、44×44 的播放按钮（实心三角）、44×44 的前进图标按钮（单个右尖括号）、等宽字体时间码「6:12 / 13:40」，然后**一段明显的空白**，最右侧是五个并排胶囊按钮：「1x」「单句循环」「跟读」「盲听」「挖空」，其中「单句循环」为激活态（`#346DA5` 文字 + `#E8F1FA` 底 + `#346DA5` 描边）。
> 5. 再往下两列：左边是字幕列表（每行＝52px 等宽时间码 + 英文句子 + 下面一行小字中文翻译，当前句有浅蓝底色和高亮的下划线词组）；右边 300px 宽的白色生词卡（18px 圆角），内含大写词形 "already" 21px、等宽音标、释义「adv. 已经」、例句、以及一条带左侧竖线的来源说明「出现在 0:11」。
> 6. 最底下四张横排小卡片，每张一个课程名 + 一行小提示。
>
> 右侧 280px 侧栏上下两张白卡：第一张「本课信息」，三行左右对齐的「难度/中级、分类/中考语法、学习进度/46%」；第二张「快捷键」，三行＝一个键帽方块 + 说明文字（空格、←、→）。
>
> 注意：**进度条和控制条中间的空白是刻意的**，别把五个胶囊挪到播放键旁边。

**S3**

> 高保真 **iPhone 竖屏** UI 设计稿，390 × 844，同一个教育视频网站的移动端内容页。
>
> 顶部 58px 白色导航栏，只保留：左边 28×28 圆角方块 Logo（E），右边靠边依次是 44×44 放大镜按钮、蓝色 VIP 徽标、44×44 烛火线性图标按钮、32×32 圆形头像。「Eastudy」品牌名和横向导航在这里**不出现**。
>
> 内容区左右内边距 12px，底色 `#F7F9FC`。21px 加粗「早上好，林同学」+ 13px 灰色副标题，一条浅色进度概览条，然后一张单列堆叠的继续学习卡片（16:9 封面在上、文字和按钮在下），再往下两列视频卡片网格。
>
> **底部固定一条标签栏**，5 等分，每格：上面一个 22px 线性图标，下面 10px 文字，依次「首页 视频库 计划 词汇 我的」，当前项「首页」是 `#346DA5`。标签栏高约 52px，白色底，顶部一条 1px 描边。
>
> 风格同上：克制、留白多、圆角柔和、无插画。

**S4**

> 高保真 **iPhone 竖屏** UI 设计稿，390 × 844，同一网站的**视频播放页**。
>
> 顶部导航栏同 S3。
>
> 内容区自上而下：16:9 黑色视频区（圆角 18px）；17px 加粗标题 + 13px 灰色副标题；8px 高圆角进度条（主色填充 + 14px 白色拖拽点）；然后控制条**分两行**——第一行是 44×44 后退、44×44 播放（实心三角）、44×44 前进、紧跟等宽时间码「6:12 / 13:40」；第二行是五个浅底胶囊「1x」「单句循环」「跟读」「盲听」「挖空」，左对齐，「单句循环」为激活态。
>
> 控制条下面：字幕列表（每行时间码 + 英文句子 + 中文小字翻译，当前句浅蓝底、句中一处词组有橙色下划线）；再往下是一张**通栏宽**的白色生词卡（不再是右侧窄栏），内容同网页版。
>
> 底部标签栏同 S3，但「视频库」为高亮态。
>
> **注意控制条是两行**，五颗胶囊在窄屏下折到第二行，别挤成一行。

**S4b（横屏沉浸）**

> 高保真 **iPhone 横屏** UI 设计稿，844 × 390，视频**全屏沉浸**播放态。
>
> 整个画面被视频铺满（深色电影感画面）。底部自下而上叠三层：最底一条细控制条（后退/播放/前进三个图标 + 时间码 + 右侧几个小胶囊，半透明）；上面一条 8px 进度条横贯全宽；再上面是**居中的双语字幕**——英文一行、中文小字一行，文字后面有半透明的深色底衬以保证可读性。
>
> 画面其余部分干净无 UI。整体像主流视频 App 的全屏播放。

### English version (for tools that prefer English)

> **S1 — Desktop content page, 1440×900.** High-fidelity UI mockup of an English-learning video site. 58px white top bar with a 1px bottom hairline. Left: 28×28 rounded-square logo (white "E" on `#346DA5`), the wordmark "Eastudy", then five horizontal nav items「首页 视频库 计划 词汇 我的」with the first one active (`#346DA5` text on `#E8F1FA` pill). Pinned to the far right, in this exact order: a 44×44 outlined magnifier icon button, a small blue VIP badge, a 44×44 outlined sun icon button, and a 32×32 circular avatar (pale blue, dark blue "林"). Content column centred, max 1240px, page background `#F7F9FC`. A 34px dark-navy heading「早上好，林同学」with a 15px grey subtitle, a pale summary strip, then one large white card (18px radius, 1px `#DCE5EF` border): 320px 16:9 thumbnail on the left with a 46px translucent white circular play button, and on the right a small「继续学习」label, 21px bold title, 13px grey meta line, a 6px progress bar 46% filled in `#346DA5`, and a solid `#346DA5` 「继续播放」button. Below: two small secondary entry rows, then a 4-column grid of video cards (16px gaps) each with a 16:9 gradient cover, 15px title, 12px grey subtitle, a small level chip, a monospaced duration, and one card carrying a 3px accent progress bar. Restrained, generous whitespace, soft radii, very subtle shadows, no illustrations, no 3D. **Do not reorder, add, or remove any icon; the top-right four must stay in the stated order.**

> **S2 — Desktop player page, 1440×900.** Same top bar with「视频库」active. Two columns: fluid main area + 280px sticky sidebar, 22px gap. Main area top to bottom: a 16:9 pure-black video surface with 18px radius; a 21px bold title and 13px grey subtitle; an 8px full-radius progress track (grey base, buffered section, `#346DA5` fill, 14px white handle with a 3px accent ring); then the **control row** — 44×44 back button (single chevron left), 44×44 play button (solid triangle), 44×44 forward button (single chevron right), a monospaced「6:12 / 13:40」, **a deliberate empty gap**, and five pill buttons pinned right:「1x」「单句循环」「跟读」「盲听」「挖空」with 「单句循环」active (`#346DA5` text on `#E8F1FA`). Below: a subtitle list on the left (52px monospaced timestamp column + English sentence with a highlighted phrase underlined in amber, plus a small grey Chinese translation line, the current row on a pale blue background) and a 300px white word card on the right (21px headword "already", monospaced phonetic, gloss, example, and a source line「出现在 0:11」with a left rule). Bottom: four small horizontal "next up" cards. Sidebar holds two white cards: 「本课信息」with three label/value rows, and 「快捷键」with three keycap rows (空格, ←, →). **The gap between the timecode and the five pills is intentional — do not move the pills next to the play button.**

> **S3 — Mobile content page, 390×844.** 58px white top bar with only the 28×28 logo on the left and, pinned right, a 44×44 magnifier, a blue VIP badge, a 44×44 candle-flame outlined icon, and a 32×32 circular avatar — no wordmark, no horizontal nav. Content with 12px side padding on `#F7F9FC`: a 21px bold greeting, a 13px grey subtitle, a pale summary strip, a single-column stacked "continue learning" card, then a 2-column video card grid. **A fixed bottom tab bar** with five equal cells, each a 22px outlined icon above a 10px label — 首页, 视频库, 计划, 词汇, 我的 — with the first active in `#346DA5`. White, ~52px tall, 1px top hairline.

> **S4 — Mobile player, 390×844.** Same top bar. Content: a 16:9 black video surface with 18px radius; a 17px bold title and grey subtitle; an 8px rounded progress bar with an accent fill and a 14px white handle; then the **control row wrapped onto two lines** — line one is 44×44 back, 44×44 play (solid triangle), 44×44 forward and the monospaced timecode; line two is the five pill buttons left-aligned with「单句循环」active. Below: a subtitle list, then a **full-width** white word card (no longer a narrow right rail). Bottom tab bar as in S3 with「视频库」active. **The control row is two lines on purpose — do not squeeze the pills onto one.**

> **S4b — Mobile landscape fullscreen, 844×390.** Video fills the frame. Bottom, stacked upward: a slim translucent control bar (back / play / forward, timecode, small pills), an 8px full-width progress bar, then **centred bilingual subtitles** — English line with a small Chinese line beneath, both on a translucent dark scrim. Everything else is empty picture. Feels like a mainstream video app in fullscreen.

---

## 十、给模型的三条硬约束（可以单独再强调一次）

1. **别动顶栏右侧四个元素的顺序**：搜索 → VIP → 主题 → 头像。这是视线和拇指的固定路径，换一次顺序老用户就要重新找。
2. **别把控制条排成等距**。左边四件一组、右边五颗胶囊一组，中间那片空白是设计的一部分。
3. **图标一律线性、2px 描边、圆角端点**，只有播放键是实心。
