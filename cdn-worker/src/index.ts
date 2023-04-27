import parseRange from "range-parser";
import { Env, ParsedRange } from "./types";
import { getRangeHeader, hasBody, isRequestAuthenticated, rangeHasLength } from "./utils";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const allowedMethods = ["GET", "PUT", "HEAD", "OPTIONS"];

    if (allowedMethods.indexOf(request.method) === -1) {
      return new Response("Method Not Allowed", {status: 405});
    }

    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { "allow": allowedMethods.join(", ") } })
    }

    if (request.method === "PUT") {
      const authorized = isRequestAuthenticated(request, env);

      if (!authorized) {
        return new Response("Unauthorized", { status: 401 });
      }

      let path = (env.PATH_PREFIX || "") + decodeURIComponent(url.pathname.substring(1));

      // Look for index file if asked for a directory
      if (env.INDEX_FILE && (path.endsWith("/") || path === "")) {
        path += env.INDEX_FILE;
      }

      try {
        await env.R2_BUCKET.put(path, request.body);
      } catch (e) {
        return new Response("Error during put operation", { status: 500 });
      }

      return new Response("OK", { status: 201 });
    }

    if (!env.INDEX_FILE && url.pathname === "/") {
      return new Response("OK");
    }

    const cache = caches.default;

    if (url.pathname.startsWith('/purgeCache')) {
      const purgeUrl = url.searchParams.get('url');

      if (!purgeUrl) {
        return new Response("No URL specified", { status: 400 });
      }

      const cached = await cache.match(purgeUrl);
      const purged = await cache.delete(purgeUrl);

      return new Response("OK", {
        headers: {
          "X-FBW-RequestedUrl": purgeUrl,
          "X-FBW-WasCached": cached ? 'true' : 'false',
          "X-FBW-CachePurged": purged ? 'true' : 'false'
        },
      });
    }

    let response = await cache.match(request);

    // Since we produce this result from the request, we don't need to strictly use an R2Range
    let range: ParsedRange | undefined;

    if (!response || !response.ok) {
      console.warn("Cache miss");
      let path = (env.PATH_PREFIX || "") + decodeURIComponent(url.pathname.substring(1));

      // Look for index file if asked for a directory
      if (env.INDEX_FILE && (path.endsWith("/") || path === "")) {
        path += env.INDEX_FILE;
      }

      let file: R2Object | R2ObjectBody | null | undefined;

      // Range handling
      if (request.method === "GET") {
        const rangeHeader = request.headers.get("range");
        if (rangeHeader) {
          file = await env.R2_BUCKET.head(path);
          if (file === null) return new Response("File Not Found", { status: 404 });
          const parsedRanges = parseRange(file.size, rangeHeader);
          // R2 only supports 1 range at the moment, reject if there is more than one
          if (parsedRanges !== -1 && parsedRanges !== -2 && parsedRanges.length === 1 && parsedRanges.type === "bytes") {
            let firstRange = parsedRanges[0];
            range = file.size === (firstRange.end + 1) ? { suffix: file.size - firstRange.start } : {
              offset: firstRange.start,
              length: firstRange.end - firstRange.start + 1
            }
          } else {
            return new Response("Range Not Satisfiable", { status: 416 });
          }
        }
      }

      // Etag/If-(Not)-Match handling
      // R2 requires that etag checks must not contain quotes, and the S3 spec only allows one etag
      // This silently ignores invalid or weak (W/) headers
      const getHeaderEtag = (header: string | null) => header?.trim().replace(/^['"]|['"]$/g, "");
      const ifMatch = getHeaderEtag(request.headers.get("if-match"));
      const ifNoneMatch = getHeaderEtag(request.headers.get("if-none-match"));

      const ifModifiedSince = Date.parse(request.headers.get("if-modified-since") || "");
      const ifUnmodifiedSince = Date.parse(request.headers.get("if-unmodified-since") || "");

      const ifRange = request.headers.get("if-range");
      if (range && ifRange && file) {
        const maybeDate = Date.parse(ifRange);

        if (isNaN(maybeDate) || new Date(maybeDate) > file.uploaded) {
          // httpEtag already has quotes, no need to use getHeaderEtag
          if (ifRange.startsWith("W/") || ifRange !== file.httpEtag) range = undefined;
        }
      }

      if (ifMatch || ifUnmodifiedSince) {
        file = await env.R2_BUCKET.get(path, {
          onlyIf: {
            etagMatches: ifMatch,
            uploadedBefore: ifUnmodifiedSince ? new Date(ifUnmodifiedSince) : undefined
          }, range
        });

        if (file && !hasBody(file)) {
          return new Response("Precondition Failed", { status: 412 });
        }
      }

      if (ifNoneMatch || ifModifiedSince) {
        // if-none-match overrides if-modified-since completely
        if (ifNoneMatch) {
          file = await env.R2_BUCKET.get(path, { onlyIf: { etagDoesNotMatch: ifNoneMatch }, range });
        } else if (ifModifiedSince) {
          file = await env.R2_BUCKET.get(path, { onlyIf: { uploadedAfter: new Date(ifModifiedSince) }, range });
        }
        if (file && !hasBody(file)) {
          return new Response(null, { status: 304 });
        }
      }

      file = request.method === "HEAD"
        ? await env.R2_BUCKET.head(path)
        : ((file && hasBody(file)) ? file : await env.R2_BUCKET.get(path, { range }));

      if (file === null) {
        return new Response("File Not Found", { status: 404 });
      }

      response = new Response((hasBody(file) && file.size !== 0) ? file.body : null, {
        status: range ? 206 : 200,
        headers: {
          "accept-ranges": "bytes",
          "access-control-allow-origin": env.ALLOWED_ORIGINS || "",

          "etag": file.httpEtag,
          "cache-control": file.httpMetadata?.cacheControl ?? (env.CACHE_CONTROL || ""),
          "expires": file.httpMetadata?.cacheExpiry?.toUTCString() ?? "",
          "last-modified": file.uploaded.toUTCString(),

          "content-encoding": file.httpMetadata?.contentEncoding ?? "",
          "content-type": file.httpMetadata?.contentType ?? "application/octet-stream",
          "content-language": file.httpMetadata?.contentLanguage ?? "",
          "content-disposition": file.httpMetadata?.contentDisposition ?? "",
          "content-range": range ? getRangeHeader(range, file.size) : "",
          "content-length": (range ? (rangeHasLength(range) ? range.length : range.suffix) : file.size).toString(),

          'x-fbw-cached-as': url.pathname,
        }
      });

      if (request.method === "GET" && (!range || 'suffix' in range)) {
        const cacheRequest = new Request(request);
        cacheRequest.headers.delete('range');
        ctx.waitUntil(cache.put(cacheRequest, response.clone()));
      }
    }

    return response;
  },
};
