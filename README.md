# Open KTV

简易版全民K歌（Web）：**上传伴奏 → 戴耳机带耳返演唱 → 服务端合成 192kbps MP3 → 试听 / 调混音 / 下载**。

单机自用，无需登录。伴奏可以传音频，也可以传视频（MV 会带画面播放）。

---

## 功能

| 模块 | 说明 |
|---|---|
| 伴奏库 | 拖拽上传（可多选）、列表试听、编辑歌名/歌手、删除；单文件上限 1GB |
| 格式兼容 | 浏览器能直接播的原文件直接用；mkv / avi / flv / h265 / ape 等**自动转码**成 mp4(h264+aac) 或 mp3 代理 |
| 演唱页 | 麦克风设备下拉、实时音量条、伴奏音量 / 耳返音量两个滑块、人声耳返一键静音、MV 画面播放 |
| 录音 | 只录麦克风**干声**（WAV，采样点精确），伴奏不进录音文件 |
| 自动对齐 | 先起录 0.15 秒静音再放伴奏，用音频图上的起播探测器在渲染时钟精确测量伴奏真正起播的时刻，混音时人声提前这段间隔（偏移可为负） |
| 混音 | 人声音量 / 伴奏音量 / 四档混响 / 人声对齐微调；「实时试听」改动立即生效，点「合成」出 MP3 |
| 响度 | 干声与伴奏分别自动响度归一化，末端限幅防削波 |
| 作品库 | 列表、播放、下载 MP3、改名、删除；合成后自动定位到对应作品 |

---

## 环境要求

- **Node.js ≥ 22.6**（用到内置 `node:sqlite` 和原生 TypeScript 类型擦除；开发时用的是 24.2）
- **ffmpeg / ffprobe 在 PATH 里**（`ffmpeg -version` 能跑就行）
- **桌面 Chrome / Edge**（音频部分用了 AudioWorklet、MediaElementSource，只保证 Chromium 系）
- **一副有线耳机** —— 耳返和「不串音」都靠它

---

## 快速开始

```bash
npm install
./openktv.sh start
```

然后打开 <http://127.0.0.1:8787>。关掉用 `./openktv.sh stop`。

### 服务管理脚本 `openktv.sh`

推荐用它来开关服务：它在后台跑（不占终端），自动记 pid、写日志、检查端口。

```bash
./openktv.sh start            # 启动（生产模式：单进程，会先自动构建前端）
./openktv.sh start --dev      # 启动开发模式（Vite 热更新 + 后端 --watch，改代码自动生效）
./openktv.sh stop             # 关闭
./openktv.sh stop --force     # 关闭，并清掉占着端口的残留进程
./openktv.sh restart          # 重启（沿用上次的模式）
./openktv.sh status           # 查看状态（运行中退出码 0，没运行退出码 1）
./openktv.sh logs             # 跟踪日志（Ctrl+C 退出，不会关掉服务）
```

| 模式 | 进程数 | 访问地址 | 说明 |
|---|---|---|---|
| `start`（默认，生产） | 1 | <http://127.0.0.1:8787> | 单进程同时托管前端和 API。每次启动都会重新构建前端（约 0.1 秒） |
| `start --dev` | 3 | <http://127.0.0.1:5173> | Vite HMR + 后端 `--watch`，改代码立刻生效 |

相关文件（都在 `.run/`，已 gitignore）：

- `.run/openktv.pid` —— 服务进程号
- `.run/openktv.mode` —— 上次用的模式，`restart` 会沿用它
- `.run/openktv.log` —— 服务和构建的完整日志

**换端口**：`PORT` 是后端，`WEB_PORT` 是开发模式下的前端，两个会一起生效
（`vite.config.ts` 的代理目标跟着 `PORT` 走）：

```bash
PORT=9000 WEB_PORT=5273 ./openktv.sh start --dev
```

### 不想用脚本的话

```bash
npm run dev              # 开发模式，前台跑，Ctrl+C 关
npm run build && npm start   # 生产模式，前台跑，Ctrl+C 关
```

前台跑的时候 `Ctrl+C` 一次就能把前后的进程都收干净（`dev.mjs` 做了信号转发）。

### 如果 `npm install` 报 EPERM

这台机器上的 `~/.npm` 里有 root 属主的文件，npm 写缓存会被拒。项目已经带了 `.npmrc`
把缓存改到项目内的 `./.npm-cache`，正常情况下不用管。

想彻底修好全局缓存：

```bash
sudo chown -R $(id -u):$(id -g) ~/.npm
```

修好之后可以删掉 `.npmrc` 里那一行。

---

## 使用流程

1. **伴奏库**：把伴奏文件拖进上传区，等状态从「转码中」变成可用。
2. **去演唱**：戴上耳机，选好麦克风（对着说话看音量条有没有反应）。
3. **开始演唱**：伴奏/画面开始播放，耳机里同时听到伴奏和自己的声音。
   两个滑块分别调伴奏音量和耳返音量；不想听自己的声音就把「人声耳返」关掉。
4. **结束演唱**：点按钮（或者伴奏放完自动结束）。干声上传后服务端立刻合成 MP3，几秒后跳转到作品编辑页。
5. **调混音**（编辑页只有两块：实时试听 → 混音调整）：点「实时试听」播放，然后拖人声音量/伴奏音量、
   混响档次、调「人声对齐微调」（滑块或直接输入毫秒数，范围 ±1000ms）—— 改动**立即**在试听里生效，不用等。
   满意后点「合成」：服务端用干声重新出一版 MP3，页面**直接返回作品库并定位到这首作品**，
   在列表里等「正在合成…」变成「已就绪」即可。
6. **播放 / 下载**：都在作品库列表页 —— ready 的作品直接内嵌播放，或点「下载 MP3」拿 192kbps 立体声文件。

---

## 工作原理

### 演唱页的音频图

```
<video>/<audio> ──MediaElementSource──┬──> accompGain ──────────────────────────────────────────────────────────────────────┐
                                      │                                                   │
                                      └──> AudioWorklet(accomp-onset) ──> captureSink(0)
                                                                                       │
MediaStreamSource ──> analyser ──> micMonitorGain ──────────────────────────────────────────────────────────────────────────────├──> destination
                  │                                                                       │
                  └──> AudioWorklet(pcm-capture) ──> captureSink(0) ──────────────────────────────────────────┘
```

三个关键点：

1. **录音只取麦克风干声**，耳返混音不写进录音文件 —— 这是后面能任意重新混音的前提。
2. `captureSink` 是个 0 增益节点，作用是让 Worklet 处在「被 destination 拉动」的路径上；
   没有它浏览器可能压根不调用 `process()`。
3. 全 App 共用一个 `AudioContext`，并且用 WeakMap 缓存 `MediaElementSource` ——
   `createMediaElementSource` 对同一个元素只能调一次。

### 对齐

干声 WAV 的 t=0 是**起录**时刻，而歌手是对着**起播后**的伴奏唱的 —— 干声第一拍
落在 WAV 时间 ≈ G（G = 起录到伴奏真正起播的间隔，含 150ms 预备静音和浏览器
seek/解码/调度延迟）。成品 MP3 里伴奏第一拍在 mix 时间 0，所以人声必须**提前 G**
才对得上，即最终偏移 `offset = userOffsetMs − autoOffsetMs`（可为负）。

1. 点「开始演唱」→ 立刻开始采集 PCM，记下渲染时钟 `captureStartCtxTime`
2. 等 150ms → `currentTime = 0; play()`，同时武装起播探测器
3. `accomp-onset` worklet 挂在 MediaElementSource 上（伴奏音量 gain 之前），
   用**渲染时钟**记下伴奏第一个非静音样本的时刻；`playing` 事件 / `currentTime`
   轮询作兜底（伴奏开头是长静音时 onset 偏大，取两者中更接近真实起播的那个）
4. `autoOffsetMs = G`（恒为正）；2.5s 内两个信号都没来回退到 150ms 常量并告警
5. 服务端按 `shared/mix.ts` 的 `mixTimeline(offset)` 决定延后哪一轨：
   offset ≥ 0 → 人声分支 `adelay`；offset < 0 → 伴奏分支 `adelay`（没有负 adelay，
   延后伴奏等价于把人声提前，干声开头那段静音正好被吃掉）

`adelay` 挂在 amix 之后就等于没对齐，所以它永远在 amix 之前的某一分支里
（有单元测试守着两个方向）。自动值之外还留了 ±1000ms 的人工微调
（正值 = 人声更晚 / 抢拍，负值 = 人声更早 / 拖拍），叠加在自动值之上。
老库作品会在启动时按 `align_ver` 一次性换算到新公式（`server/src/db.ts`）。

### 混音滤波器链

```
[0:a] aformat=48000/stereo, highpass=80, volume=<人声>, [aecho=混响], [adelay=<人声延迟>] [v];
[1:a] aformat=48000/stereo, volume=<伴奏>, [adelay=<伴奏延迟>] [a];
[v][a] amix=inputs=2:duration=first:normalize=0, alimiter=limit=0.95 [m]
```

- 两个 adelay 按 `mixTimeline(offset)` 二选一：offset ≥ 0 只延后人声，offset < 0 只延后伴奏。

- `duration=first` + 人声在第一位：成品长度跟着人声走，用户中途停不会拖出一长段纯伴奏尾巴。
- `normalize=0`：amix 默认会按输入数把音量除以 2，这里必须关掉。
- 响度归一化**没有**用 ffmpeg 的单遍 `loudnorm` 滤镜 —— 它的动态模式带内部前瞻缓冲，
  会引入不可控的时间偏移。改成「先跑一遍测量拿到输入响度，再乘一个静态增益」，零延迟且可预测。

### 实时试听（改参数不用等合成）

以前调任何参数都要点「重新生成」，等 ffmpeg 把整首 MP3 重编码一遍。现在作品编辑页的
「实时试听」在浏览器里用 Web Audio 复刻了同一条滤波器链，参数改动只操作本地音频图节点，
零网络请求、立即发声：

```
vocalBufferSource ──> vocalGain ──> highpass(80Hz) ──┬── dryGain ──────────┐
                                                      └──> convolver ──> wetGain ─┤
accompBufferSource ──> accompGain ────────────────────────────────────────────────┼──> limiter ──> destination
```

- 音量滑块 / 毫秒输入 / 混响档位的改动走 `onParamsChange` 直接进引擎；
  音量、混响用 `setTargetAtTime` 平滑过渡，**不打断播放**。
- 对齐偏移不用 `DelayNode`（改 delayTime 有爆音），靠「晚到的一轨晚起播」调度
  （offset ≥ 0 人声晚进、offset < 0 伴奏晚进，与服务端 mixTimeline 同一套规则）；
  偏移变化时防抖 120ms 后按当前位置重排两轨，无缝续播。
- 电平和成品 MP3 对齐：最近一次成功混音时实测的两轨增益（`works.levels` 列）
  随作品落库，预览按 `10^(dB/20) × 用户滑块` 复算，和服务端 `computeLevels` 同一套公式。
- 混响是卷积混响对服务端 `aecho` 的**听感近似**（四档尾巴长度递进），最终音色以下载的 MP3 为准。
- 预览时长 = 干声时长 + max(0, 对齐偏移)，和服务端 `duration=first` 一致，播完自动停。
- 干声和伴奏在首次点「试听」时才解码（懒加载），避免只下载不试听的用户白占内存；
  接近 15 分钟的录音解码后约几百 MB Float32，是已知限制。
- 编辑页因此只剩「实时试听 + 混音调整」两块；成品 MP3 的播放/下载都在作品库列表页，
  点「合成」后带着 `focusWorkId` 跳回列表，滚动到位并高亮几秒。

---

## 目录结构

```
openktv.sh        start / stop / restart / status / logs 服务管理脚本
server/src/
  index.ts        Express 入口、启动恢复、监听与信号收尾
  app.ts          createApp()：路由、静态托管、SPA 兜底、统一错误出口、请求日志
  logger.ts       日志：级别（LOG_LEVEL）+ 时间戳 + 作用域 + key=value meta
  db.ts           node:sqlite 建表与查询（tracks / works）
  probe.ts        ffprobe 封装
  classify.ts     纯函数：ffprobe JSON → 能不能直接播 / 要不要转码
  transcode.ts    代理转码参数
  ffmpeg.ts       ffmpeg 调用封装：参数常量（mp3 输出 / 进度）+ -progress 解析
  process.ts      子进程调度：超时杀掉、stderr 尾部、ENOENT 提示
  upload.ts       multer 收文件：临时目录、大小上限、错误与清理
  loudness.ts     响度测量 + 静态增益计算
  mix.ts          混音滤波器图构造（纯函数）
  mixJob.ts       一次混音的完整流程（先写 tmp 再 rename）
  jobs.ts         单并发任务队列
  media.ts        Range 流式播放
  naming.ts       文件名解码 / 歌名歌手解析 / 扩展名白名单
  routes/         tracks / works / media / guard（按 id 取记录 + 404）
web/src/
  audio/engine.ts 音频图、麦克风接入、WAV 采集
  log.ts          前端日志（开发环境 debug 起，生产只留 warn+）
  pages/          伴奏库 / 演唱页 / 作品库 / 作品详情
  components/     MixPanel、LevelMeter
shared/
  types.ts        前后端共享类型与常量
  wav.ts          Float32 → 16bit WAV 编码
scripts/
  dev.mjs         零依赖并行开发启动器
  e2e-browser.mjs CDP 浏览器端到端测试
tests/            node:test 单元与集成测试（见下文「测试」）
```

---

## 数据存放

全部在项目下的 `data/`（已加进 `.gitignore`）：

```
data/
  ktv.db          SQLite 元数据
  originals/      上传的原始伴奏（转码后也保留，混音用的就是它）
  proxies/        转码出来的播放代理 mp4/mp3
  vocals/         每次演唱的干声 WAV（重新混音的依据）
  works/          合成好的成品 MP3
  tmp/            临时文件，启动时会清空
```

**备份**直接拷整个 `data/` 就行。**重置**就把 `data/` 删掉再启动。

---

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | 后端端口（`openktv.sh` 和 `vite.config.ts` 的代理都会跟着走） |
| `WEB_PORT` | `5173` | 开发模式下 Vite 的端口 |
| `HOST` | `127.0.0.1` | 监听地址，单机自用默认只绑回环 |
| `FFMPEG_BIN` | `ffmpeg` | ffmpeg 路径（不在 PATH 里时用绝对路径） |
| `FFPROBE_BIN` | `ffprobe` | ffprobe 路径 |
| `LOG_LEVEL` | `info` | 日志详细程度：`debug` / `info` / `warn` / `error`（开发模式 `dev.mjs` 默认 `debug`） |
| `DATA_DIR` | `<项目>/data` | 数据目录整体位置，测试靠它指向临时目录 |

---

## 日志

服务端所有输出走 `server/src/logger.ts`，单行格式（重定向到 `.run/openktv.log` 时自动去掉颜色）：

```
2026-09-20T16:21:21.166Z INFO  [track] 晴天（audio）→ 直接可用：mp3 可直接播放 id=54ed… artist=周杰伦
2026-09-20T16:21:21.166Z DEBUG [http] POST /api/tracks 201 48ms
2026-09-20T16:21:21.201Z DEBUG [ffmpeg] 启动 转码 video timeoutSec=1800
2026-09-20T16:21:35.268Z INFO  [job] 完成 mix:54ed… costSec=3.2
2026-09-20T16:21:40.001Z ERROR [job] 失败 mix:54ed… error=Error: 混音超时（300s）已中止
```

- **级别**：`LOG_LEVEL` 控制，低于阈值的完全不输出；`warn`/`error` 走 stderr，其余走 stdout。
- **作用域**：`http`（请求方法/路径/状态码/耗时）、`job`（入队/开始/完成/失败）、`track`、`work`、`mix`、`ffmpeg`、`probe`、`db` 等。
- **降噪**：`/api/health`、`/api/media/*` 这类轮询/流式请求只记 `debug`，正常刷页不淹没问题行。
- 想看某个任务的 ffmpeg 参数、响度测量值这类细节就 `LOG_LEVEL=debug`。

---

## 测试

```bash
npm run typecheck    # 前端 + 后端类型检查
npm test             # node:test：约 150 个用例（含真实 ffmpeg 的集成测试）
npm run test:e2e     # 浏览器端到端（需要先另开一个终端跑 npm run dev）
npm run build        # 生产构建
```

`npm test` 覆盖：

| 文件 | 测什么 |
|---|---|
| `wav.test.ts` | Float32 → 16bit WAV 编码、分片拼接 |
| `classify.test.ts` | ffprobe JSON → 能不能直接播 / 要不要转码 |
| `naming.test.ts` | latin1 乱码还原、歌名/歌手解析、扩展名白名单 |
| `mix.test.ts` | 混音滤波器图（正/负偏移各自 adelay 挂对分支）、真实 ffmpeg 出片、响度归一化 |
| `preview.test.ts` | 前端实时预览与服务端共用的偏移/增益公式（含两边增益逐项对齐） |
| `transcode.test.ts` | mkv→mp4、奇数分辨率修正、flac→mp3 代理 |
| `logger.test.ts` | 日志级别过滤、行格式、meta 渲染、sink 路由 |
| `jobs.test.ts` | 任务队列串行、isQueued、进度钳制、失败不阻塞 |
| `dto.test.ts` | DTO 映射（不含磁盘路径）、进度来自队列 |
| `db.test.ts` | SQLite CRUD、外键、脏数据回落、重启收敛 |
| `media.test.ts` | Content-Type 表、Range/禁缓存头、下载名编码、发送错误分支 |
| `ffmpeg.test.ts` | 子进程封装的进度解析、非零退出、超时、ffmpeg 缺失提示 |
| `mix-params.test.ts` | 混音参数消毒（钳制 / 取整 / 白名单 / 回落） |
| `web-utils.test.ts` | 前端格式化函数（时长 / 计时 / 字节 / 日期） |
| `mixJob.test.ts` | 完整混音流程（真实 ffmpeg，隔离数据目录）、失败清理 |
| `http.test.ts` | 整条 API 链路（真实 Express + 临时端口 + 临时数据目录） |

碰磁盘的测试（`db` / `mixJob` / `http`）通过 `DATA_DIR` 指向系统临时目录，
不会读写真实的 `data/`；`node --test` 每个测试文件独立进程，环境变量互不干扰。

`npm run test:e2e` 用 Chrome DevTools Protocol 驱动一个真实的无头 Chrome，
配合 Chrome 的假麦克风，把「上传 → 进演唱页 → 拿到麦克风 → 录音 → 上传干声 → 合成 MP3 →
重新混音 → 上传 mkv 转码 → 画面播放」整条链路走一遍，
并且会解码干声 WAV 确认**录到的不是静音**。

```bash
HEADLESS=0 npm run test:e2e   # 想看着它自己点，用有头模式
BASE_URL=http://127.0.0.1:8787 npm run test:e2e   # 也可以测生产模式
```

---

## 常见问题

**录出来的人声断断续续 / 发闷 / 声音特别小**

浏览器自带的「降噪（noiseSuppression）」和「回声消除（echoCancellation）」是给语音通话做的：
降噪用谱减法把持续成分当噪声削掉，唱歌的长音正好符合“持续噪声”的特征；
回声消除又会把耳返里放出的自己的声音当成回声去自适应抵消。
两个叠在一起，听感就是一段一段还发闷。

本项目**已经默认关掉了它们**（`getUserMedia` 里显式传 `false`），因为那是给通话用的，不是给唱歌用的。
系统自带录音机不走这套处理，所以它录出来是正常的 —— 这也是判断依据。

如果还是断断续续，按顺序排查：

1. **设备/驱动强制开着处理**。演唱页录完会检查实际生效的设置，如果驱动硬要开，页面会明确告诉你，
   并让你去系统声音设置里关掉「环境降噪 / 语音隔离」之类的选项。
2. **采集真的在丢片**。工作线程每拍拿不到输入时会补静音并计数，丢片超过 0.5% 页面会提示。
   这种情况关掉别的吃资源的程序（视频通话、大型软件）、或换个麦克风接口再试。
3. **采样率不匹配**。麦克风常见是 44.1kHz，本项目不再强制 AudioContext 用 48kHz，
   避免在设备时钟有偏差时多插一级重采样导致周期性丢样本。录进来是 44.1k 也没关系，
   服务端混音时会统一重采样到 48k。

**啸叫 / 听到回声**
麦克风通过外放把伴奏收回去了。戴耳机 —— 关掉回声消除之后，这一点比之前更需要注意。

**耳返拖拍**
蓝牙耳机延迟普遍 150ms+，Web Audio 直连监听救不了。换有线耳机。

**音量条不动**
麦克风选错了，或者系统层面被静音了。换个设备再对着说话试试。

**「开始演唱」是灰的**
说明麦克风还没接进音频图。看按钮旁边的提示文字：可能是权限被拒（点「重试授权」）、
没有检测到设备（插上耳麦刷新页面），或者还在初始化。

**转码失败 / 服务重启把转码打断了**
失败的伴奏卡片上会有「重试处理」按钮。原文件还在，点一下重排转码，不用重新上传。

**伴奏删不掉**
被作品引用了。服务端会拒绝（409）并告诉你有几个作品，先去作品库删掉那些作品。

**成品里人声和伴奏错位**
去作品库点「调混音」进编辑页，开「实时试听」边播边调「人声对齐微调」（拖滑块或直接输入毫秒数，
范围 ±1000ms）—— 改动立即生效，对到位后点「合成」，返回作品库等「已就绪」再下载。

---

## 已知限制

- 只保证桌面 Chrome / Edge；Safari 和手机浏览器没做兼容。
- 不做音准 / 节奏打分，不做歌词滚动，不做原唱伴唱切换。
- 一次只跑一个 ffmpeg 任务（单机自用，避免抢 CPU 影响耳返）。
- 无登录、无多用户、无公网部署加固；默认只监听 127.0.0.1。
- 磁盘不做自动清理，作品和伴奏都要手动删。
