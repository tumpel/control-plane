import { HealthSchema, ProblemSchema } from "@tumpel/api/schemas";

export default {
  fetch(request: Request): Response {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz") {
      return Response.json(HealthSchema.parse({ status: "Ok" }));
    }
    const problem = ProblemSchema.parse({
      code: "NotFound",
      title: "No such route",
      detail: `No route for ${pathname}`,
      fix: "Request /healthz or a path under /v1",
    });
    return Response.json(problem, { status: 404 });
  },
} satisfies ExportedHandler;
