/* Eastudy V3 — 系统设置与健康检查 (M10).

   The health panel is the operator's first stop when something is wrong, so it
   reports three independent dependencies with their real state:

   - the edge API (proves login, Supabase and the deployment are reachable),
   - the local intake service (proves uploads can land),
   - the processing worker (proves jobs will be picked up).

   Each row shows either a green state or the actual failure text. There is no
   "assume healthy" default. */

import { el, mount, setText } from '../../core/dom.js';
import { errorState, toast, badge } from '../../ui/index.js';
import { textField, selectField, formGrid } from '../../ui/field.js';
import { describeError } from '../../services/index.js';
import { environment } from '../../config/environment.js';
/* 指令正文与版本号。放在前端而不是服务端, 是因为这一页要把它显示给运维看 ——
   见 src/admin/prompts.js 的文件头。 */
import { PROMPTS, PROMPT_VERSION } from '../prompts.js';

export function createSettingsPage({ system, api }) {
  const healthSlot = el('section', { class: 'settings__health' });
  const formSlot = el('section', { class: 'settings__form' });
  const aiSlot = el('section', { class: 'settings__ai' });

  const refreshButton = el('button', {
    class: 'btn btn--ghost btn--sm', type: 'button',
    on: { click: () => loadHealth() },
  }, '重新检测');

  const root = el('div', { class: 'page settings' },
    el('header', { class: 'page__head' },
      el('h1', { class: 'page__title' }, '系统设置'),
      el('p', { class: 'page__subtitle' }, '环境信息、依赖健康状态与处理参数。'),
      el('div', { class: 'page__actions' }, refreshButton),
    ),
    healthSlot,
    formSlot,
    aiSlot,
  );

  async function loadHealth() {
    mount(healthSlot, el('div', { class: 'skeleton skeleton--cards' }));
    const report = await system.overview();
    mount(healthSlot,
      el('h2', { class: 'section__title' }, '依赖健康'),
      el('div', { class: 'health-grid' },
        healthRow('边缘接口', report.edge, '登录、内容与发布接口'),
        healthRow('本地处理服务', report.intake, environment.intakeUrl, { showCapability: true }),
        healthRow('处理 Worker', report.worker, 'FFmpeg / 语音识别 / 翻译'),
      ),
      el('p', { class: 'health__stamp' }, `检测时间 ${formatTime(report.checkedAt)}`),
    );
  }

  function healthRow(name, state, detail, { showCapability = false } = {}) {
    const ok = Boolean(state?.ok);
    const capability = showCapability ? state?.detail : null;
    return el('article', { class: `health-card${ok ? ' is-ok' : ' is-bad'}` },
      el('header', { class: 'health-card__head' },
        el('h3', { class: 'health-card__name' }, name),
        badge(ok ? '正常' : '异常', ok ? 'ok' : 'danger'),
      ),
      el('p', { class: 'health-card__detail' }, detail || ''),
      !ok && state?.detail ? el('p', { class: 'health-card__error' }, String(state.detail)) : null,
      capability && typeof capability === 'object'
        ? el('dl', { class: 'health-card__caps' },
            el('div', null, el('dt', null, '可用磁盘'), el('dd', null, formatBytes(capability.free_bytes))),
            el('div', null, el('dt', null, '分片范围'), el('dd', null, `${formatBytes(capability.chunk_min)} – ${formatBytes(capability.chunk_max)}`)),
            el('div', null, el('dt', null, '进行中会话'), el('dd', null, String(capability.active_sessions ?? 0))),
          )
        : null,
    );
  }

  async function loadForm() {
    try {
      const settings = await system.settings();
      const profile = environment.profile(currentHost());
      const profileField = selectField({
        name: 'media-profile', label: '播放规格', value: settings.media_profile || profile,
        options: [
          { value: 'balanced-540-v1', label: 'balanced-540-v1(唯一播放档)' },
        ],
        hint: '540P 是当前唯一生产档位,720P 已停用。',
      });
      const concurrency = textField({
        name: 'upload-concurrency', label: '上传并发上限', value: String(settings.upload_max_concurrency ?? 6),
        hint: '客户端起并发,服务端仍会按磁盘与内存情况收紧。',
      });
      const retention = textField({
        name: 'source-retention', label: '原片保留天数', value: String(settings.source_retention_days ?? 7),
        hint: '超期的原片会被清理,播放文件不受影响。',
      });

      mount(formSlot,
        el('h2', { class: 'section__title' }, '处理参数'),
        formGrid(profileField.root, concurrency.root, retention.root),
        el('div', { class: 'settings__save' },
          el('button', {
            class: 'btn btn--primary', type: 'button',
            on: {
              click: async () => {
                try {
                  await system.saveSettings({
                    media_profile: profileField.value,
                    upload_max_concurrency: Number(concurrency.value) || 6,
                    source_retention_days: Number(retention.value) || 7,
                  });
                  toast('已保存', { variant: 'success' });
                } catch (error) {
                  toast(describeError(error), { variant: 'error' });
                }
              },
            },
          }, '保存设置'),
        ),
      );
    } catch (error) {
      mount(formSlot, errorState({ message: describeError(error), onRetry: loadForm }));
    }
  }

  /* ------------------------------------------------------------ 第三方模型

     这一块要回答运维的四个问题, 顺序就是他心里的顺序:

       连哪个地址    base_url   —— 校验在服务端, 前端只做格式提示
       用哪个密钥    api_key    —— 只写不读, 页面上永远拿不回来
       通不通        检测       —— 真发一次请求, 不是画个绿点
       有哪些模型    获取模型   —— 拉回列表让他选, 而不是手打一个可能拼错的
                                  名字, 等到第一次生成失败才发现

     关于密钥的显示: 已存的密钥**永远不会回到浏览器**(见
     functions/api/admin/settings/ai.js 的文件头)。所以输入框平时是空的,
     用一行占位文字告诉运维"已经存了一个,尾巴是 XXXX"。留空保存 = 不动它,
     这是 PUT 那边的既定行为, 不是这里的约定。 */
  async function loadAi() {
    try {
      const config = await system.aiConfig();
      const current = config || {};

      const provider = textField({
        name: 'ai-provider', label: '服务商名称', value: current.provider || 'DeepSeek',
        hint: '仅作标注,便于运维区分环境;实际调用只看下面的地址。',
      });

      const baseUrl = textField({
        name: 'ai-base-url', label: 'API 地址', value: current.base_url || '',
        placeholder: 'https://api.deepseek.com/v1',
        hint: 'OpenAI 兼容地址,通常以 /v1 结尾。保存时会校验,内网与本机地址不允许。',
      });

      // type=password: 屏幕上有别人时不该把密钥亮出来。它同样不会被回填。
      const apiKey = textField({
        name: 'ai-key', label: 'API 密钥', value: '', type: 'password',
        placeholder: current.key_present ? `已保存(${current.key_hint || '****'}),留空则不修改` : '尚未填写',
        hint: current.key_present
          ? '密钥已保存在服务端,出于安全不会回显。留空保存即保持不变。'
          : '密钥只保存在服务端,不会下发到浏览器。',
      });

      const model = textField({
        name: 'ai-model', label: '模型名称', value: current.model || '',
        placeholder: 'deepseek-chat',
        hint: '手填,或点"获取模型"从服务端返回的列表里选。',
      });

      /* 模型列表做成 datalist 而不是 select: 服务商列出来的模型可能几十个,
         下拉里翻找比直接打字慢; 而且允许填列表之外的模型(自建网关常常不在
         /models 里注册)。 */
      const modelList = el('datalist', { id: 'ai-model-options' });
      model.input.setAttribute('list', 'ai-model-options');

      const enabled = selectField({
        name: 'ai-enabled', label: '教学内容生成', value: current.enabled ? 'on' : 'off',
        options: [{ value: 'on', label: '开启' }, { value: 'off', label: '关闭' }],
        hint: '开启前必须已保存密钥,否则流水线会在第一次生成时失败。',
      });

      const result = el('div', { class: 'ai-result', hidden: true });
      const getModelsButton = el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        on: {
          click: () => runProbe('models', {
            baseUrl, apiKey, model, result, button: getModelsButton, modelList,
          }),
        },
      }, '获取模型');
      const testButton = el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        on: {
          click: () => runProbe('test', {
            baseUrl, apiKey, model, result, button: testButton,
          }),
        },
      }, '检测通道');

      mount(aiSlot,
        el('h2', { class: 'section__title' }, '第三方模型服务'),
        el('p', { class: 'page__subtitle' }, '流水线用这个通道生成字幕翻译与学习卡片。任何 OpenAI 兼容服务都可以。'),
        formGrid(provider.root, baseUrl.root, apiKey.root, model.root, enabled.root),
        modelList,
        /* 检测按钮放在字段下面、保存按钮上面 —— 运维的自然顺序是"填完先按
           检测, 通了再保存"。 */
        el('div', { class: 'ai-actions' }, testButton, getModelsButton),
        result,
        el('div', { class: 'settings__save' },
          el('button', {
            class: 'btn btn--primary', type: 'button',
            on: {
              click: async () => {
                try {
                  const payload = {
                    provider: provider.value,
                    base_url: baseUrl.value,
                    model: model.value,
                    enabled: enabled.value === 'on',
                  };
                  // 空字符串不是"清空密钥", 是"别碰它"。只有真的敲了字才发过去。
                  if (apiKey.value) payload.api_key = apiKey.value;
                  const response = await system.saveAiConfig(payload);
                  const saved = response?.config;
                  // 存完之后地址可能被服务端规范化过(补/去尾斜杠), 回填真值,
                  // 否则运维看到的还是自己那串、跟库里不一致。
                  if (saved?.base_url) baseUrl.value = saved.base_url;
                  if (saved?.key_present) {
                    apiKey.value = '';
                    apiKey.input.placeholder = `已保存(${saved.key_hint || '****'}),留空则不修改`;
                  }
                  toast('已保存', { variant: 'success' });
                } catch (error) {
                  toast(describeError(error), { variant: 'error' });
                }
              },
            },
          }, '保存'),
        ),
        promptSection(),
      );
    } catch (error) {
      mount(aiSlot, errorState({ message: describeError(error), onRetry: loadAi }));
    }
  }

  /* 一次检测。三个动作共用一个实现, 差别只在 mode 和要不要填模型。
     按钮在请求期间禁用 —— 连点会发出多次真实计费调用, 而且后回来的响应会
     覆盖先回来的结果, 屏幕上留下一个和当前状态不符的结论。 */
  async function runProbe(mode, { baseUrl, apiKey, model, result, button, modelList }) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = mode === 'models' ? '获取中…' : '检测中…';
    setText(result, '正在请求第三方服务…');
    result.hidden = false;
    result.className = 'ai-result is-pending';

    try {
      const response = await system.probeAi({
        mode,
        base_url: baseUrl.value,
        api_key: apiKey.value || undefined,
        model: model.value || undefined,
      });

      if (mode === 'models') {
        const models = response?.models ?? [];
        if (modelList && models.length) {
          mount(modelList, ...models.map((item) => el('option', { value: item.id })));
        }
        result.className = 'ai-result is-ok';
        setText(result, models.length
          ? `连接正常,服务端提供 ${models.length} 个模型。在"模型名称"里输入即可看到候选。耗时 ${response.latency_ms} ms。`
          : `连接正常,但该地址没有返回模型列表(耗时 ${response.latency_ms} ms)。请手工填写模型名称。`);
        return;
      }

      result.className = 'ai-result is-ok';
      setText(result, `${response?.message || '通道正常'}${response?.latency_ms ? `(耗时 ${response.latency_ms} ms)` : ''}`);
    } catch (error) {
      /* 失败原因来自服务端, 而且是被翻译过的中文(见 ai-probe.js 的
         describeUpstream)—— 401 会说"鉴权失败", 超时会说"多少秒未响应"。
         直接显示, 不要换成"检测失败"这种什么都没说的话。 */
      result.className = 'ai-result is-bad';
      setText(result, describeError(error));
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  /* 提示词不是可编辑项, 是**证据**。运维需要能看见当前跑的是第几版、
     内容是什么 —— 一条教学材料质量不对时, 要能对照指令判断是提示词的问题
     还是模型的问题。所以这里只读展示, 改指令走代码和版本号。 */
  function promptSection() {
    return el('details', { class: 'ai-prompts' },
      el('summary', null, `AI 指令(提示词)· 版本 ${PROMPT_VERSION}`),
      el('p', { class: 'field__hint' },
        '流水线按下面的顺序调用模型。改动指令必须同时升版本号, 版本号会写进每次生成的结果里。'),
      el('div', { class: 'ai-prompts__list' },
        ...PROMPTS.map((item) => el('article', { class: 'ai-prompt' },
          el('header', { class: 'ai-prompt__head' },
            el('h3', { class: 'ai-prompt__name' }, item.name),
            badge(item.stage, 'muted'),
          ),
          el('dl', { class: 'ai-prompt__meta' },
            el('div', null, el('dt', null, '输入'), el('dd', null, item.input)),
            el('div', null, el('dt', null, '输出'), el('dd', null, item.output)),
          ),
          el('pre', { class: 'ai-prompt__body' }, item.text),
        )),
      ),
    );
  }

  return {
    root,
    async mount() {
      await Promise.all([loadHealth(), loadForm(), loadAi()]);
    },
    unmount() {},
  };
}

function currentHost() {
  try { return location.hostname; } catch { return ''; }
}

function formatBytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let size = n;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatTime(input) {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', timeStyle: 'medium', dateStyle: 'short' }).format(date);
}

void setText;
void api;
