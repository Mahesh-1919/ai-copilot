/** mm:ss elapsed-time display for the active session. */
export class SessionTimer {
  private startedAt: number | null = null;
  private interval: number | null = null;

  constructor(private readonly display: HTMLElement) {}

  get running(): boolean {
    return this.startedAt !== null;
  }

  start(): void {
    this.stop();
    this.startedAt = Date.now();
    this.interval = window.setInterval(() => this.render(), 1000);
  }

  stop(): void {
    if (this.interval !== null) window.clearInterval(this.interval);
    this.interval = null;
    this.startedAt = null;
    this.display.textContent = '00:00';
  }

  private render(): void {
    if (this.startedAt === null) return;
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');
    this.display.textContent = `${mins}:${secs}`;
  }
}
