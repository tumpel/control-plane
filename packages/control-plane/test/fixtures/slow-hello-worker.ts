import { Tenant as BaseTenant } from "../../src/tenant";

export { default, HostChannel, SessionTimer } from "../../src/index";

export class Tenant extends BaseTenant {
  override async hostHello(...args: Parameters<BaseTenant["hostHello"]>): Promise<void> {
    await scheduler.wait(500);
    super.hostHello(...args);
  }
}
