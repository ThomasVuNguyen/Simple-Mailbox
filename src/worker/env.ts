export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Worker secret: encrypts the Resend key and keys the PIN hashes. Never change it casually. */
  APP_SECRET?: string;
  /** Local testing only: send Resend calls to a mock server instead of api.resend.com. */
  RESEND_API_BASE?: string;
}

export interface AppVariables {
  pinId: string;
  pinLabel: string;
}

export type AppEnv = { Bindings: Env; Variables: AppVariables };
