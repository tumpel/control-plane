import { HostRecordSchema } from "@tumpel/schemas";
import type { z } from "zod";

export { HostRecordSchema };
export type HostRecord = z.infer<typeof HostRecordSchema>;
export const HostEntrySchema = HostRecordSchema.omit({ reportedHealth: true });
export type HostEntry = z.infer<typeof HostEntrySchema>;
