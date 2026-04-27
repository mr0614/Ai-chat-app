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

        await this.recordGemini();

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

            if (!res.ok) {
              const text = await res.text();
              // ここでエラーを投げてループを継続させる
              throw new Error(`Gemini API error ${res.status}: ${text}`);
            }

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
            .slice(-6)
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
        const youPrompt =
          "あなたは自然な口語で話す人物です。" +
          " 【議題】" +
          topicText +
          " 【会話履歴】" +
          history +
          " 1〜2文で自分の視点を返す。「じゃん」「だよね」「かな」などの口語で。分析・箇条書き禁止。";

        const youPlaceholder: EngineMessage = {
          role: "you",
          text: "",
          streaming: true,
        };
        msgs = [...msgs, youPlaceholder];
        onMessage(youPlaceholder);

        const youText = await callModel(youPrompt, 150);
        if (this.aborted) break;
        // 疑似ストリーミング
        let youStreamed = "";
        for (const ch of youText) {
          if (this.aborted) break;
          youStreamed += ch;
          onMessage({ role: "you", text: youStreamed, streaming: true });
          await new Promise((r) => setTimeout(r, 50));
        }
        const youMsg: EngineMessage = { role: "you", text: youText };
        msgs = [...msgs.slice(0, -1), youMsg];
        await this.setState({ messages: msgs });
        onMessage(youMsg);
        await new Promise((r) => setTimeout(r, 300));

        // 相手AI
        const otherPrompt =
          personaPrompt +
          " 話し方: 自然な口語。毎回違う切り口。同じ言い回しを繰り返さない。" +
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
          await new Promise((r) => setTimeout(r, 50));
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
