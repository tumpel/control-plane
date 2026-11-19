import { HostSchema } from "@tumpel/schemas";
import type { z } from "zod";

export const HostRecordSchema = HostSchema.omit({
  supervisorUpdateStep: true,
  supervisorUpdateFailure: true,
  channelProtocol: true,
  guestProtocol: true,
});
export type HostRecord = z.infer<typeof HostRecordSchema>;
