import { z } from "zod";

export interface AnalyticsEnv {
  METRICS_ACCOUNT_ID?: string;
  METRICS_READ_TOKEN?: string;
}

const AnswerSchema = z.object({ data: z.array(z.record(z.string(), z.unknown())) });

export const queryAnalytics = async (env: AnalyticsEnv, sql: string): Promise<Record<string, unknown>[]> => {
  const accountId = env.METRICS_ACCOUNT_ID;
  const token = env.METRICS_READ_TOKEN;
  if (accountId === undefined || token === undefined) {
    throw new Error(
      "metrics reads need the METRICS_ACCOUNT_ID and METRICS_READ_TOKEN secrets; set them with wrangler secret put, the token with Account Analytics Read",
    );
  }
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: `${sql} FORMAT JSON`,
  });
  if (!response.ok) {
    throw new Error(
      `the Analytics Engine SQL API answered ${response.status} to a metrics query: ${(await response.text()).slice(0, 500)}`,
    );
  }
  const answer = AnswerSchema.safeParse(await response.json());
  if (!answer.success) {
    throw new Error(
      `the Analytics Engine SQL API answered a metrics query without a data array: ${answer.error.message}`,
    );
  }
  return answer.data.data;
};
