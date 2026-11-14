export default {
  fetch(request: Request): Response {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz") {
      return Response.json({ status: "Ok" });
    }
    return Response.json({ error: `No route for ${pathname}`, fix: "Request /healthz" }, { status: 404 });
  },
} satisfies ExportedHandler;
