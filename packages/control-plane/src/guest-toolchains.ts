import type { ToolchainSchema } from "@tumpel/schemas";
import type { z } from "zod";

export type Toolchain = z.infer<typeof ToolchainSchema>;

export const GUEST_TOOLCHAINS: Readonly<Record<Toolchain, string>> = {
  Node: "26.13.1",
  Rust: "1.100.0",
  Python: "3.15.2",
};
