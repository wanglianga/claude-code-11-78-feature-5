// ============================================================
// WebWorker：核验管线在后台线程执行，避免压缩/解码阻塞调查页面。
// 主线程从 IndexedDB 读取数据后结构化克隆传入，Worker 返回完整产物。
// ============================================================

import { runPipeline, type PipelineInput, type PipelineOutput } from './pipeline';
import type { VerifyProgress, VerifyRequest, VerifyResponse } from './types';

self.onmessage = async (ev: MessageEvent<VerifyRequest & { payload: PipelineInput }>) => {
  const msg = ev.data;
  if (msg.type !== 'verify') return;
  const progress: VerifyProgress = { phase: '语义对齐与版本化核验', done: 1, total: 4 };
  postMessage(progress);

  try {
    const t0 = Date.now();
    const out: PipelineOutput = await runPipeline(msg.payload);
    const elapsedMs = Date.now() - t0;
    const decodeMs = out.report.equivalence.reduce((n, e) => n + e.decodeMsB, 0);

    const resp: VerifyResponse = {
      type: 'verify_result',
      batchId: msg.batchId,
      alertCount: out.alerts.length,
      eventCount: out.eventsA.length + out.eventsB.length,
      route: msg.route,
      elapsedMs,
      decodeMs: +decodeMs.toFixed(3),
      report: out.report,
    };
    // 产物随结果一并回传，由主线程落 IndexedDB
    postMessage({ type: 'pipeline_output', output: serialize(out) });
    postMessage(resp);
  } catch (err) {
    postMessage({ type: 'verify_error', message: (err as Error).message });
  }
};

/** ContributionDict 需以普通 JSON 结构跨线程传递，主线程再还原 */
function serialize(out: PipelineOutput) {
  return {
    ...out,
    dict: out.dict.toJSON(),
  };
}
