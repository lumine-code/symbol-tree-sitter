// Keep large symbol requests interruptible between short renderer tasks.
class WorkBudget {
  constructor({
    signal,
    sliceMillis = 8,
    yieldTask = () => new Promise((resolve) => setImmediate(resolve)),
  } = {}) {
    this.signal = signal;
    this.sliceMillis = sliceMillis;
    this.yieldTask = yieldTask;
    this.reset();
  }

  reset() {
    this.operations = 0;
    this.deadline = performance.now() + this.sliceMillis;
  }

  shouldYield() {
    this.operations++;
    return (
      this.operations % 32 === 0 && (this.operations >= 2048 || performance.now() >= this.deadline)
    );
  }

  async yield() {
    if (this.signal?.aborted) return false;
    await this.yieldTask();
    this.reset();
    return !this.signal?.aborted;
  }
}

module.exports = WorkBudget;
