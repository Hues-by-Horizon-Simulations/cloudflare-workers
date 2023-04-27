# FlyByWire CDN Worker

Based on the [kotx render worker](https://github.com/kotx/render).

Proxy read and writes to [Cloudflare R2](https://developers.cloudflare.com/r2) via [Cloudflare Workers](https://workers.dev).

## Features

- Handles `HEAD`, `GET`, and `OPTIONS` requests
- Handles `PUT` requests with an `ACCESS_KEY` defined in the environment
- Forwards caching headers (`etag`, `cache-control`, `expires`, `last-modified`)
- Forwards content headers (`content-type`, `content-encoding`, `content-language`, `content-disposition`)
- Caches served files using the [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- Ranged requests (`range`, `if-range`, returns `content-range`)
- Handles precondition headers (`if-modified-since`, `if-unmodified-since`, `if-match`, `if-none-match`)
- Can serve an appended path if the requested url ends with / - Defaults to `index.html`

## Setup

### Installing wrangler

```sh
npm i -g wrangler
wrangler login
```

### Configuration

Create your R2 bucket(s) if you haven't already (replace `bucket_name` and `preview_bucket_name` appropriately):
```sh
wrangler r2 bucket create bucket_name # required
wrangler r2 bucket create preview_bucket_name # optional
```
You can also do this from the [Cloudflare dashboard](https://dash.cloudflare.com/?to=/:account/r2/buckets/new).

Edit `wrangler.toml` to have the correct `name` (worker name), `bucket_name` (the R2 bucket name) and optionally, `preview_bucket_name`  (you can set it to `bucket_name`) if you're going to run this locally.
You can do this from a fork, if using the [GitHub Actions method](#method-2-github-actions).

You may edit `CACHE_CONTROL` to the default [`cache-control` header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control) or remove it entirely to fall back to nothing.

### Deploying

Note: Due to how custom domains for workers work, you MUST use a route to take advantage of caching. Cloudflare may fix this soon.
Also note that *.workers.dev domains do not cache responses. You MUST use a route to your own (sub)domain.

#### Method 1 (Local)

```sh
npm install
wrangler publish # or `npm run deploy`
```

## Development

Install deps:

```sh
npm install
```

To launch the development server:

```sh
npm run dev
```
