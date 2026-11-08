/**
 * 语音恢复预算：WS 重连与麦克风输入恢复共用同一窗口/次数上限。
 * 迁移自 DoubaoStreamingSttProvider.canRecoverAgain，行为保持不变。
 */
export class RecoveryBudget {
  private windowStartedAt = 0;
  private count = 0;

  constructor(
    private readonly windowMs = 30_000,
    private readonly maxRecoveries = 2
  ) {}

  /** 消耗一次恢复额度；超过窗口内上限返回 false。 */
  tryConsume(): boolean {
    const now = Date.now();
    if (!this.windowStartedAt || now - this.windowStartedAt > this.windowMs) {
      this.windowStartedAt = now;
      this.count = 0;
    }
    this.count += 1;
    return this.count <= this.maxRecoveries;
  }
}
