/**
 * AudioWorklet 处理器：探测伴奏「真正开始渲染」的时刻（渲染时钟）。
 *
 * 为什么要它：干声 WAV 的 t=0 是起录时刻，歌手是对着起播后的伴奏唱的。
 * 只有知道伴奏在音频图里第一次真正出声的渲染时刻，才能算出需要从干声
 * 头部抠掉多长的静音（见 shared/mix.ts 的符号说明）。`play()` 的 promise
 * 兑现时刻、`performance.now()` 都不够准 —— 前者不含 seek/解码自旋，
 * 后者还是墙钟，和采样、媒体起播用的渲染时钟不同源。
 *
 * 挂点：从 MediaElementSource 直接抽头（在伴奏音量 gain 之前），
 * 和音量滑块解耦 —— 用户把伴奏音量拉到 0 也不影响探测。
 *
 * 判定规则：收到 'record:begin' 后开始监视，取第一个「有输入且峰值
 * 超过阈值」的渲染量子，用 AudioWorkletGlobalScope.currentTime
 * （= BaseAudioContext.currentTime，渲染时钟）post 一条消息，然后停测。
 * 暂停中的 media element 在 Chrome 里要么不喂输入、要么喂纯静音，
 * 两种情况都会被这个规则正确跳过。
 *
 * 注意：这个节点和 pcm-capture 一样，必须有一条通往 destination 的路径
 * （0 增益 sink），否则浏览器不拉它。
 */

/** 起播判定的峰值阈值：≈ -100dBFS。真实内容必然超过，解码静音不会误触 */
const ONSET_THRESHOLD = 1e-5;

class AccompOnsetProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.armed = false;
    this.port.onmessage = (event) => {
      if (event.data === 'record:begin') {
        this.armed = true;
      }
    };
  }

  process(inputs) {
    if (!this.armed) return true;

    const channel = inputs[0] && inputs[0][0];
    if (!channel) {
      // 这一拍没有输入（media element 还没开始播 / 被 seek 占住）——继续等
      return true;
    }

    let peak = 0;
    for (let i = 0; i < channel.length; i += 1) {
      const value = channel[i] < 0 ? -channel[i] : channel[i];
      if (value > peak) peak = value;
    }

    if (peak > ONSET_THRESHOLD) {
      // currentTime 是渲染时钟（秒），和 AudioContext.currentTime 同源
      this.port.postMessage({ accompOnsetTime: currentTime });
      this.armed = false;
    }
    return true;
  }
}

registerProcessor('accomp-onset', AccompOnsetProcessor);
