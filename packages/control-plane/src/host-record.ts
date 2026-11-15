import { HostSchema } from "@tumpel/api/schemas";
import type { z } from "zod";

export const HostRecordSchema = HostSchema.omit({ supervisorUpdateStep: true, supervisorUpdateFailure: true });
export type HostRecord = z.infer<typeof HostRecordSchema>;
