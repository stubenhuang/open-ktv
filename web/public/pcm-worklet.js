/**
 * AudioWorklet 处理器：把麦克风的 Float32 PCM 一块块搬回主线程。
 *
 * 为什么不用 MediaRecorder：opus 编码器有固有前导延迟，而我们要按采样点
 * 跟伴奏对齐。原始 PCM 攒成 WAV 是无损且采样点精确的。
 *
 * 注意：这个节点必须有一条通往 destination 的路径，否则浏览器不会去拉它
 * （引擎里接了一个 0 增益的 sink 来保证这点）。
 */

/** Web Audio 的固定渲染量子长度 */
const RENDER_QUANTUM = 128;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.offset = 0;
    // 诊断计数：设备抖动 / 渲染线程跟不上时，会有一拍拿不到输入
    this.frames = 0;
    this.missingQuanta = 0;

    this.port.onmessage = (event) => {
      if (event.data === 'flush') {
        this.flush();
        // flush 之后再单独报一次统计（主线程按消息类型区分）
        this.port.postMessage({
          frames: this.frames,
          missingQuanta: this.missingQuanta,
          renderQuantum: RENDER_QUANTUM,
        });
      }
    };
  }

  push(value) {
    this.buffer[this.offset] = value;
    this.offset += 1;
    if (this.offset === this.buffer.length) this.flush();
  }

  flush() {
    if (this.offset === 0) return;
    const chunk = this.buffer.slice(0, this.offset);
    this.port.postMessage(chunk, [chunk.buffer]);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];

    if (!channel) {
      // 这一拍没有输入数据（设备切换、渲染线程被抢占，或采集刚起步）。
      //
      // 这里必须补静音，不能直接跳过：跳过会让录音的时间轴整体前移，
      // 后面所有人声都会相对伴奏提前——那才是「听起来断断续续还跟不上」的根源。
      // 补静音的话，最多只是丢 2.7ms，时间轴仍然是对的。
      this.missingQuanta += 1;
      for (let i = 0; i < RENDER_QUANTUM; i += 1) this.push(0);
      this.frames += RENDER_QUANTUM;
      return true;
    }

    for (let i = 0; i < channel.length; i += 1) this.push(channel[i]);
    this.frames += channel.length;
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
