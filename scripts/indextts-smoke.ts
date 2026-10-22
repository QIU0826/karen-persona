/** IndexTTS2 链路冒烟：健康检查 + 直接合成 + 产品 synthesizeSpeech（读 .env 后端）。零成本。 */
import "dotenv/config";
import { isIndexTtsEnabled, synthesizeWithIndexTts } from "../src/ai/indextts-tts.js";
import { synthesizeSpeech } from "../src/ai/tts.js";

async function main() {
  const base = (process.env.INDEXTTS_TTS_URL ?? "http://127.0.0.1:18088").replace(/\/+$/, "");
  const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
  const h = (await health.json()) as Record<string, unknown>;
  console.log("health", JSON.stringify({ ok: h.ok, loaded: h.loaded, device: h.device, ref: h.ref_wav }));
  if (!isIndexTtsEnabled()) {
    console.log("skip product check: KAREN_TTS_BACKEND 不是 indextts2");
    return;
  }
  const direct = await synthesizeWithIndexTts("今天想你了。", {
    emoVector: [0.6, 0, 0, 0, 0, 0, 0, 0.1],
    emoAlpha: 0.7,
    durationFactor: 0.95,
  });
  console.log("direct", JSON.stringify({ ok: Boolean(direct), duration_ms: direct?.durationMs, elapsed_ms: direct?.elapsedMs }));
  const speech = await synthesizeSpeech("今天想你了。", {
    styleEnabled: true,
    style: { emotionVector: 0.5, hour: 14, closeness: 6 },
  });
  console.log("product", JSON.stringify({ ok: Boolean(speech), duration_ms: speech?.durationMs, bytes: speech?.byteLength }));
  if (!direct || !speech) process.exitCode = 1;
}
void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
