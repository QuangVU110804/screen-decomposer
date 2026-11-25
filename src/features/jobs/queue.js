'use strict';
function createQueue(store, maxWaiting = 2) {
  const waiting = [];
  let active = null, closing = false;
  function drain() {
    if (active || !waiting.length || closing) return;
    const item = waiting.shift(); active = item;
    item.promise = Promise.resolve().then(() => item.task(item.controller.signal)).catch(error => {
      const job = store.get(item.id);
      if (job && job.status !== 'canceled') store.put({ ...job, status: 'failed', stage: 'failed', error: error.message });
    }).finally(() => { active = null; drain(); });
  }
  return {
    hasCapacity: () => !closing && (!active || waiting.length < maxWaiting),
    submit(id, task) {
      if (closing || (active && waiting.length >= maxWaiting)) throw Object.assign(new Error('Hàng đợi đầy. Hãy chờ một lượt quét hoàn tất.'), { status: 429 });
      waiting.push({ id, task, controller: new AbortController() }); drain();
    },
    cancel(id) {
      const index = waiting.findIndex(item => item.id === id);
      if (index >= 0) waiting.splice(index, 1);
      if (active?.id === id) active.controller.abort();
      const job = store.get(id);
      if (job && !['done', 'partial', 'failed', 'canceled'].includes(job.status)) store.put({ ...job, status: 'canceled', stage: 'canceled', error: null });
      return store.get(id);
    },
    async close() {
      closing = true;
      for (const item of [...waiting]) this.cancel(item.id);
      if (active) { this.cancel(active.id); await active?.promise; }
    },
  };
}
module.exports = { createQueue };
