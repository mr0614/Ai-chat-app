// chatEngine.ts — タブをまたいで動き続ける会話エンジン
// _layout.tsxでインスタンス化し、ai.tsxはAsyncStorageで状態を参照する

import AsyncStorage from "@react-native-async-storage/async-storage";

export const CHAT_STATE_KEY = "chat_engine_state";
export const CHAT_PARTIAL_KEY = "chat_engine_partial";

export interface EngineMessage {
  role: "you" | "other" | "topic";
  text: string;
  streaming?: boolean;
}

export interface ChatEngineState {
  messages: EngineMessage[];
  topic: string;
  started: boolean;
  paused: boolean;
  loading: boolean;
  turnCount: number;
  sessionId: string;
  personaId: string;
  toneId: string;
  error: string;
  waitingMsg: string; // "Gemini間隔待機中..." などの状態メッセージ
}

const defaultState = (): ChatEngineState => ({
  messages: [],
  topic: "",
  started: false,
  paused: false,
  loading: false,
  turnCount: 0,
  sessionId: "",
  personaId: "contrarian",
  toneId: "normal",
  error: "",
  waitingMsg: "",
});

// ─── エンジン本体 ───────────────────────────────────────
class ChatEngine {
  private aborted = false;
  private running = false;
  private listeners: (() => void)[] = [];

  // 外部から状態変化を購読できるようにする
  subscribe(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((f) => f !== fn);
    };
  }

  private notify() {
    this.listeners.forEach((f) => f());
  }

  async getState(): Promise<ChatEngineState> {
    try {
      const j = await AsyncStorage.getItem(CHAT_STATE_KEY);
      return j ? JSON.parse(j) : defaultState();
    } catch {
      return defaultState();
    }
  }

  async setState(patch: Partial<ChatEngineState>): Promise<void> {
    const current = await this.getState();
    const next = { ...current, ...patch };
    await AsyncStorage.setItem(CHAT_STATE_KEY, JSON.stringify(next));
    this.notify();
  }

  abort() {
    this.aborted = true;
  }

  async reset() {
    this.aborted = true;
    this.running = false;
    await AsyncStorage.removeItem(CHAT_STATE_KEY);
    await AsyncStorage.removeItem(CHAT_PARTIAL_KEY);
    this.notify();
  }

  // ─── メインの会話ループ ──────────────────────────────
  async runTurns(
    model: string,
    apiKeys: Record<string, string>,
    personaPrompt: string,
    turns: number,
    onMessage: (msg: EngineMessage) => void,
    userContext: string = "",
    userPersona: string = "",
  ): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.aborted = false;
    const state = await this.getState();
    const INTERVAL = 4500;
    let lastGemini = 0;

    await this.setState({
      loading: true,
      paused: false,
      error: "",
      waitingMsg: "",
    });

    const callModel = async (
      prompt: string,
      maxTokens: number,
    ): Promise<string> => {
      if (model === "gemini") {
        const rawKey = await AsyncStorage.getItem("ai_apikey_gemini");
        const key = rawKey?.trim(); 
        if (!key) throw new Error("Gemini APIキーが未設定です");

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(key)}`;

        for (let attempt = 0; attempt < 3; attempt++) {
          if (this.aborted) return "";

          try {
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig: { maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } },
              }),
            });

            // 成功・失敗に関わらずステータスコードをログ出力

            if (res.status === 429 || res.status === 503) {
              let waitSec = res.status === 503 ? 10 : 35;
              try {
                const errJson = await res.clone().json();
                const errMsg = errJson?.error?.message ?? "";
                const m = errMsg.match(/retry in ([0-9.]+)s/i);
                if (m) waitSec = Math.ceil(parseFloat(m[1])) + 3;
              } catch {}
              await this.setState({ waitingMsg: (res.status === 429 ? "Gemini 429" : "Gemini 503") + ": " + waitSec + "秒待機中..." });
              await new Promise((r) => setTimeout(r, waitSec * 1000));
              await this.setState({ waitingMsg: "" });
              continue;
            }
            if (!res.ok) {
              const text = await res.text();
              throw new Error("Gemini API error " + res.status + ": " + text);
            }

            this.recordGemini().catch(() => {});
            const d = await res.json();
            return d.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
          } catch (e) {
            if (attempt === 2) throw e;
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          }
        }

        for (let attempt = 0; attempt < 3; attempt++) {
          if (this.aborted) return "";

          try {
            const res = await fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json", 
              },
              body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig: { maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } },
              }),
            });

            if (!res.ok) {
              const errorData = await res.json();
              // 400エラーの原因の多くはキーの無効化か形式ミス
              throw new Error(
                "Gemini API error: " +
                  (errorData.error?.message || res.statusText),
              );
            }

            const d = await res.json();
            return d.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
          } catch (e) {
            if (attempt === 2) throw e;
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          }
        }
      }

      if (model === "openai") {
        const key = apiKeys.openai || ""; 
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + key,
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            max_tokens: maxTokens,
          }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error("OpenAI " + res.status);
        return d.choices?.[0]?.message?.content?.trim() ?? "";
      }

      if (model === "groq") {
        const key = apiKeys.groq || "";
        if (!key) throw new Error("GroqのAPIキーが未設定です\nconsole.groq.comで無料取得できます");
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
          body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }], max_tokens: maxTokens }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error("Groq " + res.status + ": " + (d.error?.message ?? ""));
        return d.choices?.[0]?.message?.content?.trim() ?? "";
      }


      // Claude
      {
        const key =
          apiKeys.claude || process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY || "";
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-request-allowed": "true",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: maxTokens,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error("Claude " + res.status);
        return d.content?.[0]?.text?.trim() ?? "";
      }
    };

    try {
      let currentState = await this.getState();
      let msgs = [...(currentState.messages ?? [])];

      const variations = [
        "今回は質問で返す。",
        "今回は具体的な例を出す。",
        "今回は相手の言葉を引用してから切り込む。",
        "今回は予想外の角度から返す。",
        "今回は短く断言する。",
        "今回は少し感情的に返す。",
        "今回は逆説的な視点を出す。",
        "今回は相手の前提を疑う。",
      ];

      for (let t = 0; t < turns; t++) {
        if (this.aborted) break;
        currentState = await this.getState();
        const history =
          msgs
            .filter((m) => m.role !== "topic")
            .slice(-4)
            .map(
              (m) => (m.role === "you" ? "あなたAI" : "相手AI") + ": " + m.text,
            )
            .join(" / ") || "なし";

        const variation =
          variations[Math.floor(Math.random() * variations.length)];

        // あなたAI
        const topicText =
          currentState.topic ||
          msgs.find((m) => m.role === "topic")?.text ||
          "";
        // あなたAIの口調：設定 > index/myworldデータから推定 の優先順位
        const youPersonaBase = userPersona
          ? "あなたは以下の設定のキャラクターです: " + userPersona + " "
          : userContext
          ? "あなたはこのユーザーです。" + userContext + " このユーザーになりきって自然に話してください。"
          : "あなたは自然な口語で話す人物です。";
        // キャラ定義：設定優先→MyWorldデータから突出した傾向で尖ったキャラ
        const youCharaDef = userPersona
          ? "あなたは以下の設定のキャラクターです: " + userPersona
          : userContext
          ? "以下のデータから「最も突出した傾向」だけを抽出して尖ったキャラを作れ。平均化・丸め禁止。" +
            "例：SF多い+哲学書 → 「実存的な問いに取り憑かれたオタク」として話す。" +
            "データ：" + userContext
          : "自然な口語で話す人物";

        const youPrompt =
          youCharaDef +
          " 【必須：毎ターン以下を全て含める】" +
          "①議題のキーワードを**太字**で1つ明示する " +
          "②そのキーワードに関するトリビア・豆知識・裏話・制作秘話を1つ出す " +
          "③比喩かユーモアを1つ使う（例えると〜） " +
          "④なぜそうなるかの理由を説明する " +
          "⑤前の発言を受けて新しい切り口で発展させる（言い換え・同意だけ禁止） " +
          " 【禁止】他作品の無理な引用・浅い感想・箇条書き・長文分析 " +
          " 【文体】口語。100〜150文字程度。 " +
          " 【議題】" + topicText +
          " 【会話履歴】" + history;

        const youPlaceholder: EngineMessage = {
          role: "you",
          text: "",
          streaming: true,
        };
        msgs = [...msgs, youPlaceholder];
        onMessage(youPlaceholder);

        console.log('[ENGINE] userPersona:', userPersona?.slice(0,50), 'userContext:', userContext?.slice(0,50));
        console.log('[ENGINE] youPrompt first 300:', youPrompt.slice(0, 300));
        const youText = await callModel(youPrompt, 150);
        if (this.aborted) break;
        // 疑似ストリーミング
        let youStreamed = "";
        for (const ch of youText) {
          if (this.aborted) break;
          youStreamed += ch;
          onMessage({ role: "you", text: youStreamed, streaming: true });
          await new Promise((r) => setTimeout(r, 30));
        }
        const youMsg: EngineMessage = { role: "you", text: youText };
        msgs = [...msgs.slice(0, -1), youMsg];
        await this.setState({ messages: msgs });
        onMessage(youMsg);
        await new Promise((r) => setTimeout(r, 300));

        // 相手AI
        const otherPrompt =
          personaPrompt +
          " 【必須：毎ターン以下を全て含める】" +
          "①議題のキーワードを**太字**で1つ明示する " +
          "②そのキーワードに関するトリビア・豆知識・裏話・制作秘話を1つ出す " +
          "③比喩かユーモアを1つ使う（例えるなら〜） " +
          "④なぜそうなるかの理由を説明する " +
          "⑤前の発言を受けて新しい切り口で発展させる（言い換え・同意だけ禁止） " +
          " 【禁止】他作品の無理な引用・浅い感想・長文分析 " +
          " 【文体】口調・性格を必ず守る。100〜150文字程度。 " +
          " 【議題】" +
          topicText +
          " 【会話履歴】" +
          history +
          " / あなたAI: " +
          youText +
          " " +
          variation +
          " 1〜2文。";

        const otherPlaceholder: EngineMessage = {
          role: "other",
          text: "",
          streaming: true,
        };
        msgs = [...msgs, otherPlaceholder];
        await this.setState({ messages: msgs });
        onMessage(otherPlaceholder);

        const otherText = await callModel(otherPrompt, 150);
        if (this.aborted) break;
        // 疑似ストリーミング
        let otherStreamed = "";
        for (const ch of otherText) {
          if (this.aborted) break;
          otherStreamed += ch;
          onMessage({ role: "other", text: otherStreamed, streaming: true });
          await new Promise((r) => setTimeout(r, 30));
        }
        const otherMsg: EngineMessage = { role: "other", text: otherText };
        msgs = [...msgs.slice(0, -1), otherMsg];
        await this.setState({ messages: msgs });
        onMessage(otherMsg);
        await new Promise((r) => setTimeout(r, 300));
      }

      const finalState = await this.getState();
      await this.setState({
        messages: msgs,
        loading: false,
        paused: true,
        turnCount: (finalState.turnCount ?? 0) + turns,
        waitingMsg: "",
        error: "",
      });
    } catch (e: any) {
      await this.setState({
        loading: false,
        paused: true,
        error: e?.message ?? "エラーが発生しました",
        waitingMsg: "",
      });
    }
    this.running = false;
    this.notify();
  }

  private async recordGemini(): Promise<void> {
    try {
      const j = await AsyncStorage.getItem("ai_usage_stats");
      const u = j ? JSON.parse(j) : { gemini: { minuteRequests: 0, minuteStart: Date.now(), totalRequests: 0, timestamps: [] }, claude: { inputTokens: 0, outputTokens: 0, cost: 0 }, openai: { inputTokens: 0, outputTokens: 0, cost: 0 } };
      const now = Date.now();
      if (!u.gemini.timestamps) u.gemini.timestamps = [];
      u.gemini.timestamps = [...u.gemini.timestamps.filter((t: number) => now - t < 60000), now];
      u.gemini.minuteRequests = u.gemini.timestamps.length;
      u.gemini.minuteStart = u.gemini.timestamps[0] ?? now;
      u.gemini.totalRequests += 1;
      await AsyncStorage.setItem("ai_usage_stats", JSON.stringify(u));
    } catch {}
  }

  private async recordTokens(
    model: "claude" | "openai",
    input: number,
    output: number,
  ): Promise<void> {
    try {
      const pricing = {
        claude: { input: 3 / 1e6, output: 15 / 1e6 },
        openai: { input: 0.15 / 1e6, output: 0.6 / 1e6 },
      };
      const j = await AsyncStorage.getItem("ai_usage_stats");
      const u = j
        ? JSON.parse(j)
        : {
            gemini: {
              minuteRequests: 0,
              minuteStart: Date.now(),
              totalRequests: 0,
            },
            claude: { inputTokens: 0, outputTokens: 0, cost: 0 },
            openai: { inputTokens: 0, outputTokens: 0, cost: 0 },
          };
      u[model].inputTokens += input;
      u[model].outputTokens += output;
      u[model].cost +=
        input * pricing[model].input + output * pricing[model].output;
      await AsyncStorage.setItem("ai_usage_stats", JSON.stringify(u));
    } catch {}
  }
}

export const chatEngine = new ChatEngine();

// expo-router対策：デフォルトエクスポートが必要
export default {};
