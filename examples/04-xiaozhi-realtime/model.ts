// 从环境变量装配豆包实时语音。缺什么直接报出来。
import { doubaoRealtime } from "@voxengine/providers/doubao";

export function env(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!value) throw new Error(`缺少环境变量 ${name}，见 examples/04-xiaozhi-realtime/.env.example`);
  return value;
}

export function createModel() {
  return doubaoRealtime({
    apiKey: env("DOUBAO_API_KEY"),
    voice: env("DOUBAO_REALTIME_VOICE", "zh_female_vv_jupiter_bigtts"),
  });
}
