const { updateJob } = require('./jobService');

const MAX_QUEUE_WAITING = 5;
const QUEUE_FULL_MESSAGE = 'Hàng đợi đầy, vui lòng thử lại sau vài phút';

let active = null;
const queue = [];

function queueError() {
  const error = new Error(QUEUE_FULL_MESSAGE);
  error.code = 'QUEUE_FULL';
  error.statusCode = 429;
  return error;
}

function refreshPositions() {
  queue.forEach((item, index) => {
    updateJob(item.jobId, { status: 'pending', queuePosition: index + 1 });
  });
}

async function run(item) {
  active = item;
  updateJob(item.jobId, { queuePosition: null });
  try {
    await item.task();
  } catch (error) {
    // Tasks normally own their error state. This outer guard handles a task
    // that rejects before it can update the job and keeps the queue moving.
    const job = updateJob(item.jobId, {
      status: 'failed',
      error: error?.message || String(error),
      queuePosition: null,
    });
    if (job) console.error(`[queue] job ${item.jobId} failed: ${job.error}`);
  } finally {
    active = null;
    const next = queue.shift();
    refreshPositions();
    if (next) void run(next);
  }
}

function enqueue(jobId, task) {
  if (typeof task !== 'function') throw new TypeError('Pipeline task must be a function');
  if (active) {
    if (queue.length >= MAX_QUEUE_WAITING) throw queueError();
    queue.push({ jobId, task });
    updateJob(jobId, { status: 'pending', queuePosition: queue.length, error: null });
    return { queued: true, position: queue.length };
  }

  void run({ jobId, task });
  return { queued: false, position: 0 };
}

function getState() {
  return {
    running: Boolean(active),
    activeJobId: active?.jobId || null,
    waiting: queue.map((item) => item.jobId),
  };
}

function resetForTests() {
  if (active) throw new Error('Cannot reset pipeline queue while a task is running');
  queue.splice(0, queue.length);
}

module.exports = {
  MAX_QUEUE_WAITING,
  QUEUE_FULL_MESSAGE,
  enqueue,
  getState,
  resetForTests,
};
