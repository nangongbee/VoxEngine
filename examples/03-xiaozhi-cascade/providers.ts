// 从环境变量装配豆包识别 / 方舟大模型 / 豆包合成。缺什么直接报出来。
import { doubaoAsr, doubaoTts } from "@voxengine/providers/doubao";
import { openaiChat } from "@voxengine/providers/openai";

function env(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!value) throw new Error(`缺少环境变量 ${name}，见 examples/03-xiaozhi-cascade/.env.example`);
  return value;
}

const doubaoAuth = () =>
  process.env.DOUBAO_API_KEY?.trim()
    ? { apiKey: env("DOUBAO_API_KEY") }
    : { appId: env("DOUBAO_APP_ID"), accessKey: env("DOUBAO_ACCESS_KEY") };

export function createProviders() {
  return {
    stt: doubaoAsr(doubaoAuth()),
    llm: openaiChat({
      name: "ark",
      baseUrl: env("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3"),
      apiKey: env("ARK_API_KEY"),
      model: env("ARK_MODEL"),
      temperature: 0.3,
      extraBody: { thinking: { type: "disabled" } },
    }),
    tts: doubaoTts({ ...doubaoAuth(), speaker: env("DOUBAO_TTS_SPEAKER", "zh_female_vv_uranus_bigtts") }),
  };
}
