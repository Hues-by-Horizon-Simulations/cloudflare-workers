export interface Env {
  R2_BUCKET: R2Bucket,
  ACCESS_KEY: string,
  ALLOWED_ORIGINS?: string,
  CACHE_CONTROL?: string,
  PATH_PREFIX?: string
  INDEX_FILE?: string
}

export type ParsedRange = { offset: number, length: number } | { suffix: number };
