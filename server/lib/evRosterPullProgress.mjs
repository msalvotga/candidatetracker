/**
 * In-memory pull progress for long EV roster bulk pulls (polled by the UI).
 */

/** @type {Map<string, object>} */
const jobs = new Map();

/** @type {string|null} */
let latestJobId = null;

/**
 * @param {string} jobId
 * @param {object} initial
 */
export function beginPullProgress(jobId, initial = {}) {
  const id = String(jobId ?? "").trim();
  if (!id) return;
  latestJobId = id;
  jobs.set(id, {
    active: true,
    phase: "starting",
    message: "Starting pull…",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    step: 0,
    totalSteps: 0,
    ...initial,
  });
}

/**
 * @param {string} jobId
 * @param {object} patch
 */
export function updatePullProgress(jobId, patch) {
  const id = String(jobId ?? "").trim();
  if (!id) return;
  const cur = jobs.get(id) ?? { active: true };
  jobs.set(id, {
    ...cur,
    ...patch,
    active: patch.active !== undefined ? patch.active : cur.active !== false,
    updatedAt: new Date().toISOString(),
  });
  latestJobId = id;
}

/**
 * @param {string} jobId
 * @param {object} final
 */
export function finishPullProgress(jobId, final = {}) {
  const id = String(jobId ?? "").trim();
  if (!id) return;
  updatePullProgress(id, { ...final, active: false });
}

/**
 * @param {string} [jobId]
 */
export function getPullProgress(jobId) {
  const id = String(jobId ?? "").trim();
  if (id) return jobs.get(id) ?? { active: false, jobId: id };
  if (latestJobId && jobs.has(latestJobId)) return jobs.get(latestJobId);
  return { active: false };
}

/** Drop finished jobs older than 1 hour. */
export function prunePullProgress() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    const t = Date.parse(job.updatedAt ?? job.startedAt ?? "");
    if (!job.active && Number.isFinite(t) && t < cutoff) jobs.delete(id);
  }
}
