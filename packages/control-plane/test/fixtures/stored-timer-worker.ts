import { SessionTimer as BaseSessionTimer } from "../../src/session-timer";

export { default, HostChannel, Tenant } from "../../src/index";

export class SessionTimer extends BaseSessionTimer {
  async store(timers: unknown, at: number): Promise<void> {
    await this.ctx.storage.put("timers", timers);
    await this.ctx.storage.setAlarm(at);
  }

  async stored(): Promise<unknown> {
    return this.ctx.storage.get("timers");
  }
}
