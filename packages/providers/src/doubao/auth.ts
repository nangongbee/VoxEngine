/**
 * 豆包语音两种鉴权：新控制台的 API Key，或旧控制台的 App ID + Access Key。
 * 同一账号里不同资源开通在哪一种上不一定，所以两种都支持。
 */
export interface DoubaoAuth {
  apiKey?: string;
  appId?: string;
  accessKey?: string;
}

export function authHeaders(auth: DoubaoAuth, appIdHeader: "X-Api-App-Id" | "X-Api-App-Key"): Record<string, string> {
  if (auth.apiKey) return { "X-Api-Key": auth.apiKey };
  if (auth.appId && auth.accessKey) return { [appIdHeader]: auth.appId, "X-Api-Access-Key": auth.accessKey };
  throw new Error("豆包语音需要 apiKey，或 appId + accessKey");
}
