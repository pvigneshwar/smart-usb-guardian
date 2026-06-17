export const COMMON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "x-content-type-options": "nosniff",
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...COMMON_HEADERS, ...extraHeaders },
  });
}

export function error(message, status = 400, extra = {}) {
  return json({ detail: message, ...extra }, status);
}

export function methodNotAllowed() {
  return error("Method not allowed.", 405);
}

export async function readJson(req) {
  try {
    return await req.json();
  } catch {
    const problem = new Error("Request body must contain valid JSON.");
    problem.status = 400;
    throw problem;
  }
}

export function redirect(req, pathname, filename = null) {
  const target = new URL(pathname, req.url);
  const headers = {
    location: target.toString(),
    "cache-control": "no-store",
  };
  if (filename) {
    headers["content-disposition"] = `attachment; filename="${filename}"`;
  }
  return new Response(null, { status: 302, headers });
}
