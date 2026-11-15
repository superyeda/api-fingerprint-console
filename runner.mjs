import { loadDetector, parseNumbers, buildRequest } from 'lmfpd-sdk';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { LIMITATION, redact } from './store.mjs';
import { sendNotification } from './notify.mjs';
import { notificationSecretValues } from './notification-config.mjs';

export function classify(result, endpoint, limits) {
  const a = result?.analysis;
  if (!a) return { status: 'technical_error', reason: '未取得有效指纹分析；本轮无法评分。' };
  if (['not_model', 'unscorable'].includes(a.decision)) return { status: 'inconclusive', reason: '回答无法形成可靠的指纹排名。' };
  if (result.error) return { status: 'technical_error', reason: '接口或取样失败；不能据此判断降质。' };
  const unusual = (result.samples || []).some(s => { const n = parseNumbers(s.text || ''); return n.length && n.every(i => i >= 200); });
  if (unusual || a.decision !== 'scored' || a.used_outputs !== 3 || a.probability_status !== 'reference_calibrated' || !Number.isFinite(a.probability) || a.probability < limits.confidenceThreshold) return { status: 'inconclusive', reason: '有效样本或校准置信度不足，本轮无法可靠判断。' };
  return endpoint.expectedCandidateIds.includes(a.prediction) || endpoint.expectedCandidateNames.includes(a.prediction_name)
    ? { status: 'match', reason: '指纹与目标合并类别一致。' }
    : { status: 'suspect', reason: '第一候选不属于配置的目标类别，需要复核；不是换模或降质证明。' };
}
export function configKey(endpoint, key, intervalHours) {
  return createHash('sha256').update(JSON.stringify({ endpointId: endpoint.id, baseUrl: endpoint.baseUrl, model: endpoint.model, api: endpoint.api, effort: endpoint.effort, keyId: key.id, credentialVersion: key.credentialVersion, expectedCandidateIds: endpoint.expectedCandidateIds, expectedCandidateNames: endpoint.expectedCandidateNames, intervalHours })).digest('hex');
}
export function streak(summary, previous, intervalHours) {
  if (summary.status !== 'suspect') return 0;
  const gap = Date.parse(summary.startedAt) - Date.parse(previous?.startedAt);
  return previous?.status === 'suspect' && previous.configKey === summary.configKey && previous.detectorVersion === summary.detectorVersion && previous.topModel === summary.topModel && gap > 0 && gap <= (intervalHours * 60 + 40) * 60000 ? (previous.anomalyStreak || 1) + 1 : 1;
}
export function due(summary, signature, now, hours) {
  if (!summary || summary.configKey !== signature) return true;
  const gap = now - Date.parse(summary.startedAt);
  return !Number.isFinite(gap) || gap >= hours * 3600000 - 120000;
}
export function selectTargets(vault, selection = {}) {
  const all = vault.config.endpoints.flatMap(endpoint => endpoint.keys.map(key => ({ endpoint, key })));
  return all.filter(({ endpoint, key }) => (!selection.endpointId || endpoint.id === selection.endpointId) && (!selection.keyId || key.id === selection.keyId));
}
export function runnableTargets(vault, selection = {}) { return selectTargets(vault, selection).filter(({ endpoint, key }) => endpoint.enabled && key.enabled && vault.secrets[key.id]); }

export async function runBatch(store, options = {}) {
  const now = options.now || (() => new Date());
  const startedAt = now().toISOString();
  const vault = await store.privateSnapshot();
  const secrets = [...Object.values(vault.secrets), ...notificationSecretValues(vault.notificationSecrets)];
  const targets = selectTargets(vault, options.selection);
  const batch = { startedAt, finishedAt: null, mode: options.scheduled ? 'scheduled' : 'manual', results: [] };
  const oldResults = new Map((await store.results()).map(r => [r.keyId, r]));
  const limits = vault.config.limits;
  const intervalHours = vault.config.schedule.intervalHours;
  let detector;
  let loadFailed = false;
  await store.atomic('current-run.json', { running: true, pid: process.pid, startedAt, activeAlias: null });
  try {
    for (const { endpoint, key } of targets) {
      const identity = { endpointId: endpoint.id, endpointName: endpoint.name, keyId: key.id, alias: key.alias, requestedModel: endpoint.model, api: endpoint.api, effort: endpoint.effort };
      const signature = configKey(endpoint, key, intervalHours);
      const previous = oldResults.get(key.id);
      if (!endpoint.enabled || !key.enabled || !vault.secrets[key.id]) {
        batch.results.push({ ...identity, startedAt: now().toISOString(), status: 'skipped', reason: !vault.secrets[key.id] ? '未配置 Key；没有发送请求，也没有本轮新结果。' : '已停用；没有发送请求，也没有本轮新结果。', requestsSent: 0, alert: false }); continue;
      }
      if (options.scheduled && !due(previous, signature, now().getTime(), intervalHours)) {
        batch.results.push({ ...identity, startedAt: now().toISOString(), status: 'skipped', reason: '本间隔已有记录；没有重复请求，也没有本轮新结果。', requestsSent: 0, previousReportId: previous?.reportId, alert: false }); continue;
      }
      const keyStarted = now().toISOString();
      await store.atomic('current-run.json', { running: true, pid: process.pid, startedAt, activeAlias: key.alias });
      let summary; let analysis = null;
      try {
        const requestConfig = { baseUrl: endpoint.baseUrl, apiKey: vault.secrets[key.id], model: endpoint.model, api: endpoint.api, effort: endpoint.effort, count: 3, parallel: 3, timeout: 120, stream: true, strict: false };
        if ('error' in buildRequest(requestConfig, 'Local request validation.')) throw new Error('request_invalid');
        if (!detector && !loadFailed) {
          try { detector = await (options.detectorLoader || loadDetector)({ cache: join(store.dir, 'detector-cache.bin') }); }
          catch { loadFailed = true; }
        }
        if (!detector) throw new Error('reference_unavailable');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), limits.roundTimeoutSeconds * 1000);
        const stop = () => controller.abort();
        process.once('SIGTERM', stop); process.once('SIGINT', stop);
        let result;
        try { result = await detector.detect(requestConfig, { signal: controller.signal }); }
        finally { clearTimeout(timer); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
        const a = result?.analysis;
        const outcome = classify(result, endpoint, limits);
        analysis = a ? { decision: a.decision, probability_status: a.probability_status, used_outputs: a.used_outputs, prediction: a.prediction, prediction_name: a.prediction_name, probability: a.probability, results: a.results, model_version: a.model_version } : null;
        summary = { ...identity, startedAt: keyStarted, finishedAt: now().toISOString(), ...outcome, validSamples: a?.used_outputs || 0, sampleCount: 3,
          topModel: a?.prediction || null, topName: a?.prediction_name || null, probability: a?.probability ?? null, configKey: signature,
          detectorBuiltAt: detector.builtAt, detectorVersion: a?.model_version ? JSON.stringify(a.model_version) : null, anomalyStreak: 0, alert: false, limitation: LIMITATION };
        summary.anomalyStreak = streak(summary, previous, intervalHours);
        summary.alert = summary.anomalyStreak >= limits.consecutiveAnomalies;
      } catch {
        summary = { ...identity, startedAt: keyStarted, finishedAt: now().toISOString(), status: 'technical_error', reason: loadFailed ? '参考库加载失败，未进行模型评分。' : '接口、取样或检测失败；未自动重试，不能据此认定降质。', validSamples: 0, sampleCount: 3, topName: null, probability: null, configKey: signature, alert: false, anomalyStreak: 0, limitation: LIMITATION };
      }
      batch.results.push(await store.saveSummary(summary, analysis, secrets));
    }
    batch.finishedAt = now().toISOString();
    const safe = redact(batch, secrets);
    try { safe.notification = await (options.notifier || sendNotification)(safe, { enabled: vault.config.notifications.enabled, config: vault.config.notifications, secrets: vault.notificationSecrets }); }
    catch { safe.notification = { status: 'failed' }; }
    await store.atomic('last-batch.json', safe);
    return safe;
  } finally {
    await store.atomic('current-run.json', { running: false, pid: process.pid, startedAt, finishedAt: now().toISOString(), activeAlias: null });
  }
}
