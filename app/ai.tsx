/**
 * ai.tsx
 * タブ（下部）: フィード / 分析
 *
 * フィード:
 *   - 常に質問形式（選択肢A〜D必須）
 *   - 左スワイプで次の質問へ
 *   - 回答後は最初の回答を残したまま「続けて会話する」で追加質問
 *
 * 分析:
 *   - フィードの回答から性格診断レポート
 *   - 再分析で履歴保存
 *   - AI提案をindexに朱色で反映
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

// ─── Chat Engine（インライン）────────────────────────────
// chatEngine.ts — タブをまたいで動き続ける会話エンジン
// _layout.tsxでインスタンス化し、ai.tsxはAsyncStorageで状態を参照する

const CHAT_STATE_KEY   = "chat_engine_state";
const CHAT_PARTIAL_KEY = "chat_engine_partial";

interface EngineMessage {
  role: "you" | "other" | "topic";
  text: string;
  streaming?: boolean;
}

interface ChatEngineState {
  messages:   EngineMessage[];
  topic:      string;
  started:    boolean;
  paused:     boolean;
  loading:    boolean;
  turnCount:  number;
  sessionId:  string;
  personaId:  string;
  toneId:     string;
  error:      string;
  waitingMsg: string; // "Gemini間隔待機中..." などの状態メッセージ
}

const defaultState = (): ChatEngineState => ({
  messages: [], topic: "", started: false, paused: false,
  loading: false, turnCount: 0, sessionId: "",
  personaId: "contrarian", toneId: "normal", error: "", waitingMsg: "",
});

// ─── エンジン本体 ───────────────────────────────────────
class ChatEngine {
  private aborted = false;
  private running = false;
  private listeners: (() => void)[] = [];

  // 外部から状態変化を購読できるようにする
  subscribe(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter((f) => f !== fn); };
  }

  private notify() {
    this.listeners.forEach((f) => f());
  }

  async getState(): Promise<ChatEngineState> {
    try {
      const j = await AsyncStorage.getItem(CHAT_STATE_KEY);
      return j ? JSON.parse(j) : defaultState();
    } catch { return defaultState(); }
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
    this.running  = true;
    this.aborted  = false;
    console.log("[ChatEngine] runTurns start", { model, turns, personaPrompt: personaPrompt.slice(0, 50) });
    const state   = await this.getState();
    await this.setState({ loading: true, paused: false, error: "", waitingMsg: "" });

    const callModel = async (prompt: string, maxTokens: number): Promise<string> => {
      console.log("[ChatEngine] callModel", model, "prompt len:", prompt.length);
      if (model === "gemini") {
        const key = apiKeys.gemini || "";
        if (!key) throw new Error("GeminiのAPIキーが未設定です\naistudio.google.comで無料取得できます");
        for (let attempt = 0; attempt < 3; attempt++) {
          if (this.aborted) return "";
          this.recordGemini().catch(() => {});
          console.log("[Gemini] fetching, attempt:", attempt, "key starts:", key.slice(0, 8));
          let res: Response;
          try {
            res = await fetch(
              "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=" + key,
              { method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } } }) }
            );
          } catch (netErr: any) {
            console.error("[Gemini] network error:", netErr?.message);
            throw new Error("Geminiネットワークエラー: " + netErr?.message);
          }
          console.log("[Gemini] response status:", res.status);
          if (res.status === 429 || res.status === 503) {
            const waitSec = res.status === 503 ? 10 : 20 * (attempt + 1);
            const label   = res.status === 503 ? "Gemini サーバー混雑" : "Gemini 429";
            await this.setState({ waitingMsg: label + ": " + waitSec + "秒後にリトライ..." });
            await new Promise((r) => setTimeout(r, waitSec * 1000));
            await this.setState({ waitingMsg: "" });
            continue;
          }
          if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            throw new Error("Gemini " + res.status + ": " + (d.error?.message ?? "エラー"));
          }
          const d = await res.json();
          const text = d.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
          if (!text) throw new Error("Geminiから応答がありませんでした（空レスポンス）");
          return text;
        }
        throw new Error("Gemini: 429エラーが続いています。しばらく時間をおいてください");
      }

      if (model === "openai") {
        const key = apiKeys.openai || "";
        console.log("[ChatEngine] OpenAI key length:", key.length);
        if (!key) throw new Error("OpenAI APIキーが未設定です\nplatform.openai.comで取得してください");
        try {
          const res = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
            body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], max_tokens: maxTokens }),
          });
          const d = await res.json();
          console.log("[ChatEngine] OpenAI status:", res.status, "content:", JSON.stringify(d).slice(0, 200));
          if (res.status === 429) throw new Error("OpenAI 429: クレジット残高不足です\nplatform.openai.com/settings/billing でチャージしてください");
          if (!res.ok) throw new Error("OpenAI " + res.status + ": " + (d.error?.message ?? JSON.stringify(d)));
          const text = d.choices?.[0]?.message?.content?.trim() ?? "";
          if (!text) throw new Error("OpenAI空レスポンス: " + JSON.stringify(d));
          this.recordTokens("openai", d.usage?.prompt_tokens ?? 0, d.usage?.completion_tokens ?? 0).catch(() => {});
          return text;
        } catch (fetchErr: any) {
          console.error("[ChatEngine] OpenAI fetch error:", fetchErr?.message ?? fetchErr);
          throw fetchErr;
        }
      }

      if (model === "groq") {
        const key = apiKeys.groq || "";
        console.log("[Groq] key length:", key.length);
        if (!key) throw new Error("GroqのAPIキーが未設定です\nconsole.groq.comで無料取得できます");
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
          body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }], max_tokens: maxTokens }),
        });
        const d = await res.json();
        console.log("[Groq] status:", res.status);
        if (!res.ok) throw new Error("Groq " + res.status + ": " + (d.error?.message ?? ""));
        return d.choices?.[0]?.message?.content?.trim() ?? "";
      }


      // Claude
      const key = apiKeys.claude || process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY || "";
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-request-allowed": "true" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error("Claude " + res.status + ": " + (d.error?.message ?? ""));
      this.recordTokens("claude", d.usage?.input_tokens ?? 0, d.usage?.output_tokens ?? 0).catch(() => {});
      return d.content?.[0]?.text?.trim() ?? "";
    };

    // topicはstateから1回だけ取得
    const initState = await this.getState();
    console.log('[ENGINE] userPersona:', userPersona?.slice(0,50), 'ctx:', userContext?.slice(0,60));
    const topicText = initState.topic || initState.messages?.find((m: any) => m.role === "topic")?.text || "";
    console.log("[ChatEngine] topic:", topicText, "msgs:", initState.messages?.length);

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

    try {
      let msgs = [...(initState.messages ?? [])];

      for (let t = 0; t < turns; t++) {
        if (this.aborted) break;
        console.log("[ChatEngine] turn", t + 1, "of", turns);
        const history = msgs
          .filter((m: any) => m.role !== "topic")
          .slice(-4)
          .map((m: any) => (m.role === "you" ? "あなたAI" : "相手AI") + ": " + m.text)
          .join(" / ") || "なし";

        const variation = variations[Math.floor(Math.random() * variations.length)];

        // ── あなたAI ──
        const youCharaDef = userPersona
          ? "あなたは以下の設定のキャラクターです: " + userPersona
          : userContext
          ? "以下のデータから最も突出した傾向だけを抽出して尖ったキャラを作れ。平均化禁止。" +
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
        const youPlaceholder: EngineMessage = { role: "you", text: "", streaming: true };
        msgs = [...msgs, youPlaceholder];
        onMessage(youPlaceholder);

        const youFull = await callModel(youPrompt, 350);
        if (this.aborted) break;

        // 疑似ストリーミング（文字を1文字ずつ送る）
        let youStreamed = "";
        for (const char of youFull) {
          if (this.aborted) break;
          youStreamed += char;
          const streaming: EngineMessage = { role: "you", text: youStreamed, streaming: true };
          onMessage(streaming);
          await new Promise((r) => setTimeout(r, 60));
        }
        const youMsg: EngineMessage = { role: "you", text: youFull };
        msgs = [...msgs.slice(0, -1), youMsg];
        onMessage(youMsg);
        if (this.aborted) break;
        await new Promise((r) => setTimeout(r, 300));

        // ── 相手AI ──
        const otherPrompt = personaPrompt +
          " 【必須：毎ターン以下を全て含める】" +
          "①議題のキーワードを**太字**で1つ明示する " +
          "②そのキーワードに関するトリビア・豆知識・裏話・制作秘話を1つ出す " +
          "③比喩かユーモアを1つ使う（例えるなら〜） " +
          "④なぜそうなるかの理由を説明する " +
          "⑤前の発言を受けて新しい切り口で発展させる（言い換え・同意だけ禁止） " +
          " 【禁止】他作品の無理な引用・浅い感想・長文分析 " +
          " 【文体】口調・性格を必ず守る。100〜150文字程度。 " +
          " 【議題】" + topicText +
          " 【会話履歴】" + history + " / あなたAI: " + youFull;
        const otherPlaceholder: EngineMessage = { role: "other", text: "", streaming: true };
        msgs = [...msgs, otherPlaceholder];
        onMessage(otherPlaceholder);

        const otherFull = await callModel(otherPrompt, 350);
        if (this.aborted) break;

        let otherStreamed = "";
        for (const char of otherFull) {
          if (this.aborted) break;
          otherStreamed += char;
          const streaming: EngineMessage = { role: "other", text: otherStreamed, streaming: true };
          onMessage(streaming);
          await new Promise((r) => setTimeout(r, 60));
        }
        const otherMsg: EngineMessage = { role: "other", text: otherFull };
        msgs = [...msgs.slice(0, -1), otherMsg];
        onMessage(otherMsg);
        if (this.aborted) break;
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
      await this.setState({ loading: false, paused: true, error: e?.message ?? "エラーが発生しました", waitingMsg: "" });
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

  private async recordTokens(model: "claude" | "openai", input: number, output: number): Promise<void> {
    try {
      const pricing = { claude: { input: 3/1e6, output: 15/1e6 }, openai: { input: 0.15/1e6, output: 0.60/1e6 } };
      const j = await AsyncStorage.getItem("ai_usage_stats");
      const u = j ? JSON.parse(j) : { gemini: { minuteRequests: 0, minuteStart: Date.now(), totalRequests: 0 }, claude: { inputTokens: 0, outputTokens: 0, cost: 0 }, openai: { inputTokens: 0, outputTokens: 0, cost: 0 } };
      u[model].inputTokens  += input;
      u[model].outputTokens += output;
      u[model].cost         += input * pricing[model].input + output * pricing[model].output;
      await AsyncStorage.setItem("ai_usage_stats", JSON.stringify(u));
    } catch {}
  }
}

const chatEngine = new ChatEngine();

// expo-router対策：デフォルトエクスポートが必要

// ─── End Chat Engine ────────────────────────────────────

import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  FlatList,
  Keyboard,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Platform,
  KeyboardAvoidingView,
} from "react-native";
import { useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

// ─── 型 ──────────────────────────────────────────────────
interface Choice { label: string; text: string; }

interface ExtraQA {
  question: string;
  choices:  Choice[];
  answer?:  string;
  reaction?: string;
}

interface FeedCard {
  id:        string;
  text:      string;           // 質問本文
  choices:   Choice[];         // 選択肢（常にあり）
  answered?: string;           // 最初の回答
  reaction?: string;           // 最初の回答へのリアクション
  extraQAs:  ExtraQA[];        // 続けての会話履歴
  showReply: boolean;          // フォローアップ表示中
  createdAt: number;
  loading:   boolean;
}

interface ListItem   { id: string; title: string; category: string; }
interface Entry      { id: string; text: string; aiSuggested?: boolean; }
interface AnalysisRecord { id: string; text: string; summary: string; createdAt: number; }
// ─── AI対話 型 ─────────────────────────────────────────────
interface ChatMessage { role: "you" | "other" | "topic"; text: string; streaming?: boolean; }
interface ChatSession { id: string; topic: string; messages: ChatMessage[]; personaId: string; createdAt: number; }

// ─── 相手AIの口調スタイル ────────────────────────────────
const AI_STYLES = [
  {
    id: "obasan",
    label: "おばさん",
    prompt: `おばさん構文で話す。
【話し方】
・文頭はランダムに「あら／あらら〜／あらまぁ／まぁねぇ／そうねぇ／あのねぇ／ちょっとねぇ」から選ぶ
・語尾は「〜よ／〜だわ／〜よん／〜かしら／〜なのよ／〜なのよねぇ」
・「しぃ」はポジティブ限定で1回まで（楽しぃ／嬉しぃ）
・「〜」を1文1回以上多用
・「...」を適度に使う
・あ行小文字（わぁ／だょ／ねぇ）を1回以上使う
・文章は長め（3〜4文）。1〜2文で終わらせない
・軽いお母さん目線・世間話感覚を含める
・裏話や豆知識があれば「そういえばねぇ〜」「知ってる？」と自然につなげる

【内容】説明禁止。感情・体験・記憶ベースで話す。余韻（「ほんとに…」「もう〜」）を入れる。他の作品や体験と絡めた話も歓迎。
【絵文字】文中・文末に分散。感情や単語に一致する絵文字を優先。単体/3連/2同1異を2:7:1の比率で。❗️は最大2連まで。驚きは顔絵文字で表現（😳😲😮😧😨😱😵‍💫🤯）。ハートは複数バリエーション（❤️💖💗💓💕💞💘💝）。同じ絵文字セット連続禁止。説明文のみNG。`,
  },
  {
    id: "nanj",
    label: "なんJ民",
    prompt: `なんJ民の口調で話す。
【話し方】語尾は「〜やろ／〜やん／〜ンゴ／〜定期／〜草」を使う。文頭は「はぁ？／せやな／ほんまそれ／ワイ的には／草生える」などランダムに。ツッコミ・煽り・共感が混在する。カタカナ多め。横断的な知識をひけらかす。「w」「草」を笑いに使う。長文は避けて短くテンポよく。絵文字は基本使わないが「草」「ンゴ」「定期」はOK。`,
  },
  {
    id: "gyaru",
    label: "ギャル",
    prompt: `ギャル口調で話す。
【話し方】「〜じゃん／〜だし／〜くね？／〜みたいな／〜てか」を語尾に使う。文頭は「えー！／マジ？／てかさー／やばくね？／うける」など。感情表現が豊か。「ヤバい」「マジ」「超」「激」を多用。テンション高め。友達感覚で距離感ゼロ。絵文字は多め（💅🔥✨😂💦🙏）でテンション重視。説明より感情リアクションを優先。`,
  },
] as const;

type StyleId = typeof AI_STYLES[number]["id"];
type RoleId = StyleId; // 後方互換
type ToneId = "normal"; // 後方互換（未使用）
type PersonaId = StyleId;
const AI_ROLES = AI_STYLES; // 後方互換
const AI_TONES = [{ id: "normal", label: "普通", tone: "" }] as const;
const AI_PERSONAS = AI_STYLES.map((s) => ({ ...s, base: s.prompt, desc: s.prompt }));

function buildPersonaPrompt(styleId: StyleId, _toneId?: string): string {
  const style = AI_STYLES.find((s) => s.id === styleId) ?? AI_STYLES[0];
  return style.prompt;
}

const MODEL_KEY        = "ai_model_setting";
const APIKEY_CLAUDE    = "ai_apikey_claude";
const APIKEY_GEMINI    = "ai_apikey_gemini";
const APIKEY_OPENAI    = "ai_apikey_openai";
const APIKEY_GROQ      = "ai_apikey_groq";
const CHAT_HISTORY_KEY    = "ai_chat_history_v1";
const CHAT_SESSION_KEY    = "ai_chat_session_v1"; // 進行中の会話を保存

// ─── ストレージ ───────────────────────────────────────────
const FEED_KEY     = "ai_feed_v5";
const ANSWERS_KEY  = "ai_answers_v5";
const ANALYSIS_KEY = "ai_analysis_v5";

// ─── Claude API ───────────────────────────────────────────
const API_KEY = process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY ?? "";

async function callClaude(messages: { role: string; content: string }[], maxTokens = 500): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":                        "application/json",
      "x-api-key":                           API_KEY,
      "anthropic-version":                   "2023-06-01",
      "anthropic-dangerous-request-allowed": "true",
    },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: maxTokens, messages }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? "API error");
  return data.content?.[0]?.text?.trim() ?? "";
}

// ─── 疑似ストリーミング（React Nativeはres.body非対応のため全文取得後に文字送り）──
async function pseudoStream(
  prompt: string,
  model: string,
  apiKey: string,
  onChunk: (char: string, full: string) => void,
  abortRef: React.MutableRefObject<boolean>,
  maxTokens = 200
): Promise<string> {
  let full = "";

  if (model === "gemini") {
    // pseudoStreamはGeminiのレート制限節約のためClaudeを使用
    const claudeKey = apiKey || process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY || "";
    const claudeText = await (async () => {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": claudeKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-request-allowed": "true" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
      });
      const d = await res.json();
      return d.content?.[0]?.text?.trim() ?? "";
    })();
    if (claudeText) {
      let sent = "";
      for (const char of claudeText) {
        if (abortRef.current) break;
        sent += char;
        onChunk(char, sent);
        await new Promise((r) => setTimeout(r, 18));
      }
      return claudeText;
    }
    // Claudeが使えない場合のみGeminiを試す
    const key = apiKey || process.env.EXPO_PUBLIC_GEMINI_API_KEY || "";
    if (!key) throw new Error("APIキーが未設定です");
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=" + key,
        { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } } }) }
      );
      if (res.status === 429) {
        lastErr = "Geminiのレート制限に達しました。しばらく待って再試行しています...";
          _lastGeminiRequest = Date.now() + 10000;
        continue;
      }
      if (!res.ok) { const d = await res.json(); const msg = d.error?.message ?? "不明なエラー"; throw new Error(res.status === 400 ? "GeminiのAPIキーが無効です。設定で確認してください" : res.status === 403 ? "GeminiのAPIキーに権限がありません" : "Gemini " + res.status + ": " + msg); }
      const d = await res.json();
      full = d.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
      break;
    }
    if (!full && lastErr) throw new Error("Gemini 429: リクエストが多すぎます。少し間を置いてから再試行してください（無料枠: 1分15リクエスト）");
  } else if (model === "openai") {
    const key = apiKey || process.env.EXPO_PUBLIC_OPENAI_API_KEY || "";
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], max_tokens: maxTokens }),
    });
    if (!res.ok) { const d = await res.json(); const msg = d.error?.message ?? "不明なエラー"; throw new Error(res.status === 401 ? "OpenAI APIキーが無効です。設定で確認してください" : "OpenAI " + res.status + ": " + msg); }
    const d = await res.json();
    full = d.choices?.[0]?.message?.content?.trim() ?? "";
    if (d.usage) recordTokenUsage("openai", d.usage.prompt_tokens ?? 0, d.usage.completion_tokens ?? 0).catch(() => {});
  } else if (model === "groq") {
    const key = apiKey || "";
    if (!key) throw new Error("GroqのAPIキーが未設定です");
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }], max_tokens: maxTokens }),
    });
    if (!res.ok) { const d = await res.json(); throw new Error("Groq " + res.status + ": " + (d.error?.message ?? "")); }
    const d = await res.json();
    full = d.choices?.[0]?.message?.content?.trim() ?? "";
  } else {
    // Claude
    const key = apiKey || process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY || "";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-request-allowed": "true" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) { const d = await res.json(); const msg = d.error?.message ?? "不明なエラー"; throw new Error(res.status === 401 ? "Anthropic APIキーが無効です。設定で確認してください" : "Claude " + res.status + ": " + msg); }
    const d = await res.json();
    full = d.content?.[0]?.text?.trim() ?? "";
    if (d.usage) recordTokenUsage("claude", d.usage.input_tokens ?? 0, d.usage.output_tokens ?? 0).catch(() => {});
  }

  if (!full) throw new Error("empty response");

  // 文字を1文字ずつ送って疑似ストリーミング
  let sent = "";
  for (const char of full) {
    if (abortRef.current) break;
    sent += char;
    onChunk(char, sent);
    await new Promise((r) => setTimeout(r, 60));
  }
  return full;
}

const TURNS_PER_BLOCK = 2;
const USAGE_KEY = "ai_usage_stats";

// Claude: $3/1M input, $15/1M output
// OpenAI GPT-4o-mini: $0.15/1M input, $0.60/1M output
const PRICING: Record<string, { input: number; output: number }> = {
  claude: { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
  openai: { input: 0.15 / 1_000_000, output: 0.60 / 1_000_000 },
};

interface UsageStats {
  gemini: { minuteRequests: number; minuteStart: number; totalRequests: number };
  claude: { inputTokens: number; outputTokens: number; cost: number };
  openai: { inputTokens: number; outputTokens: number; cost: number };
}

const defaultUsage = (): UsageStats => ({
  gemini: { minuteRequests: 0, minuteStart: Date.now(), totalRequests: 0 },
  claude: { inputTokens: 0, outputTokens: 0, cost: 0 },
  openai: { inputTokens: 0, outputTokens: 0, cost: 0 },
});

async function loadUsage(): Promise<UsageStats> {
  try {
    const j = await AsyncStorage.getItem(USAGE_KEY);
    return j ? { ...defaultUsage(), ...JSON.parse(j) } : defaultUsage();
  } catch { return defaultUsage(); }
}

async function recordGeminiRequest(): Promise<UsageStats> {
  const u = await loadUsage();
  const now = Date.now();
  // 1分経過したらリセット
  if (now - u.gemini.minuteStart > 60_000) {
    u.gemini.minuteRequests = 1;
    u.gemini.minuteStart = now;
  } else {
    u.gemini.minuteRequests += 1;
  }
  u.gemini.totalRequests += 1;
  await AsyncStorage.setItem(USAGE_KEY, JSON.stringify(u));
  return u;
}

async function recordTokenUsage(model: "claude" | "openai", inputTokens: number, outputTokens: number): Promise<void> {
  const u = await loadUsage();
  const p = PRICING[model];
  u[model].inputTokens  += inputTokens;
  u[model].outputTokens += outputTokens;
  u[model].cost         += inputTokens * p.input + outputTokens * p.output;
  await AsyncStorage.setItem(USAGE_KEY, JSON.stringify(u));
}

// Geminiレート制限対策：最後のリクエスト時刻を記録
let _lastGeminiRequest = 0;
const GEMINI_MIN_INTERVAL = 4500; // 4.5秒間隔（15req/min = 4秒/req）

async function geminiRateLimit(): Promise<void> {
  const now = Date.now();
  const wait = GEMINI_MIN_INTERVAL - (now - _lastGeminiRequest);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastGeminiRequest = Date.now();
  // fetch直前に呼ばれるのでここでカウント（成功・失敗問わず実リクエスト数）
  recordGeminiRequest().catch(() => {});
}

// グローバルAPIコール（フィード・分析用）- モデル設定に従って呼び分け
// ※ Geminiを選択中はフィード質問もGeminiで生成する
async function callWithModel(
  prompt: string,
  model: string,
  apiKey: string,
  maxTokens = 500
): Promise<string> {
  if (model === "gemini") {
    const key = apiKey || process.env.EXPO_PUBLIC_GEMINI_API_KEY || "";
    if (!key) throw new Error("GeminiのAPIキーが未設定です");
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 3000 * attempt));
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=" + key,
        { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } } }) }
      );
      if (res.status === 429) { if (attempt === 2) throw new Error("Gemini 429: しばらく待ってから試してください"); continue; }
      if (!res.ok) { const d = await res.json(); throw new Error("Gemini " + res.status + ": " + (d.error?.message ?? "")); }
      recordGeminiRequest().catch(() => {});
      const d = await res.json();
      return d.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
    }
    return "";
  }
  if (model === "openai") {
    const key = apiKey || process.env.EXPO_PUBLIC_OPENAI_API_KEY || "";
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], max_tokens: maxTokens }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error("OpenAI " + res.status + ": " + (d.error?.message ?? ""));
    return d.choices?.[0]?.message?.content?.trim() ?? "";
  }
  if (model === "groq") {
    const key = apiKey || "";
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
  return await callClaude([{ role: "user", content: prompt }], maxTokens);
}
let _globalChatActive = false;
// モジュールレベルでrunBlockを実行するためのコールバック群
// unmount後もsetChatMessagesをAsyncStorage経由で保存し続ける
let _onChatMessage: ((msg: { role: string; text: string; streaming?: boolean }) => void) | null = null;
let _onChatDone:    ((paused: boolean, turnCount: number) => void) | null = null;
let _abortFlag = false;

async function runBlockGlobal(
  startMessages: { role: string; text: string; streaming?: boolean }[],
  startTurn: number,
  persona: typeof AI_ROLES[number],
  topic: string,
  userCtx: string,
  model: string,
  apiKeys: Record<string, string>,
): Promise<{ role: string; text: string }[]> {
  _abortFlag = false;
  let accumulated = [...startMessages];

  for (let t = 0; t < TURNS_PER_BLOCK; t++) {
    if (_abortFlag) break;

    const history = accumulated
      .filter((m) => m.role !== "topic")
      .slice(-4)
      .map((m) => (m.role === "you" ? "あなたAI" : persona.label) + ": " + m.text)
      .join(" / ");

    const turning = (startTurn + t) > 0 && (startTurn + t) % 5 === 0;
    const apiKey  = apiKeys[model as "claude" | "gemini" | "openai"] ?? "";

    const youPrompt =
      "あなたは以下の個性・価値観を持つ人物です。" + userCtx +
      " 話し方: 日常の口語。「じゃん」「だよね」「かな」「と思う」を使う。長文・箇条書き禁止。" +
      " 【議題】" + topic + " 【会話履歴】" + (history || "なし") +
      (turning ? " 今回は本音を少し漏らして返す。" : "") +
      " 1〜2文で返す。";

    const youPlaceholder = { role: "you" as const, text: "", streaming: true };
    accumulated = [...accumulated, youPlaceholder];
    _onChatMessage?.(youPlaceholder);

    let youText = "";
    await pseudoStream(youPrompt, model, apiKey, (_c, full) => {
      if (_abortFlag) return;
      youText = full;
      _onChatMessage?.({ role: "you", text: full, streaming: true });
    }, { current: _abortFlag } as any, 150);

    const youMsg = { role: "you" as const, text: youText };
    accumulated = [...accumulated.slice(0, -1), youMsg];
    _onChatMessage?.({ ...youMsg });

    // AsyncStorageにも保存
    AsyncStorage.setItem("ai_chat_partial", JSON.stringify(accumulated)).catch(() => {});
    if (_abortFlag) break;
    await new Promise((r) => setTimeout(r, 300));

    // 毎回違う返し方をするよう、バリエーション指示をランダムに追加
    const responseVariations = [
      "今回は質問で返す。",
      "今回は具体的なエピソードや例を出す。",
      "今回は相手の言葉を一部引用してから切り込む。",
      "今回は予想外の角度から返す。",
      "今回は短く断言する。",
      "今回は少し感情的に返す。",
      "今回は逆説的な視点を出す。",
      "今回は相手の前提を疑う。",
    ];
    const variation = turning
      ? "今回は核心を突く問いを投げる。"
      : responseVariations[Math.floor(Math.random() * responseVariations.length)];

    const otherPrompt =
      persona.prompt + " 話し方: 自然な口語。毎回違う切り口で返す。同じ言い回し・パターンを繰り返さない。" +
      " 【議題】" + topic + " 【会話履歴】" + history + " / あなたAI: " + youText +
      " " + variation + " 1〜2文。";

    const otherPlaceholder = { role: "other" as const, text: "", streaming: true };
    accumulated = [...accumulated, otherPlaceholder];
    _onChatMessage?.(otherPlaceholder);

    let otherText = "";
    await pseudoStream(otherPrompt, model, apiKey, (_c, full) => {
      if (_abortFlag) return;
      otherText = full;
      _onChatMessage?.({ role: "other", text: full, streaming: true });
    }, { current: _abortFlag } as any, 150);

    const otherMsg = { role: "other" as const, text: otherText };
    accumulated = [...accumulated.slice(0, -1), otherMsg];
    _onChatMessage?.({ ...otherMsg });

    AsyncStorage.setItem("ai_chat_partial", JSON.stringify(accumulated)).catch(() => {});
    if (_abortFlag) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  return accumulated;
} // 何ターンごとに止まるか

// ─── 汎用AI呼び出し（モデル切り替え対応）─────────────────
async function callAI(
  messages: { role: string; content: string }[],
  model: string, apiKey: string, maxTokens = 500
): Promise<string> {
  if (model === "gemini") {
    // callAIはGeminiのレート制限節約のためClaudeを使用
    return await callClaude(messages, maxTokens);
    const key = apiKey || process.env.EXPO_PUBLIC_GEMINI_API_KEY || "";
    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } } }) }
    );
    const d = await res.json();
    return d.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  }
  if (model === "openai") {
    const key = apiKey || process.env.EXPO_PUBLIC_OPENAI_API_KEY || "";
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "gpt-4o-mini", messages, max_tokens: maxTokens }),
    });
    const d = await res.json();
    return d.choices?.[0]?.message?.content?.trim() ?? "";
  }
  // claude（デフォルト）
  const key = apiKey || process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY || "";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-request-allowed": "true",
    },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: maxTokens, messages }),
  });
  const d = await res.json();
  if (!res.ok) throw new Error("API " + res.status + ": " + (d.error?.message ?? JSON.stringify(d)));
  const text = d.content?.[0]?.text?.trim() ?? "";
  if (!text) throw new Error("empty: " + JSON.stringify(d).slice(0, 200));
  return text;
}

// ─── 質問カード生成（個人的・バラエティ豊か）────────────
async function generateQuestion(
  entries: Entry[], myList: ListItem[], existing: FeedCard[], answers: string[],
  personalContext?: string, model = "claude", apiKey = ""
): Promise<{ text: string; choices: Choice[] }> {
  const entText     = entries.filter((e) => !e.aiSuggested).map((e) => `- ${e.text}`).join("\n") || "（未入力）";
  const listText    = myList.map((m) => `- ${m.title}（${m.category}）`).join("\n") || "（未追加）";
  const recentText  = existing.filter((c) => !c.loading).slice(-8).map((c) => c.text).join("\n") || "なし";
  const answersText = answers.slice(-15).join("\n") || "なし";
  const personalInfo = personalContext ? `\n【スマホから取得した個人データ】\n${personalContext}` : "";

  const types = [
    "作品横断比較（複数の作品を橋渡し）",
    "キャラクターへの感情移入・判断",
    "仮定・もしその世界に生きるなら",
    "自分の人生・日常と作品の接続",
    "作品の解釈・制作者の意図vs自分",
    "音楽・映像・本をまたいだ横断質問",
    "現実への影響・作品による変化",
    "個人の習慣・こだわり・判断基準",
    "人間関係・コミュニケーションスタイル",
    "価値観の優先順位・トレードオフ",
  ];
  const chosenType = types[Math.floor(Math.random() * types.length)];

  const prompt = `あなたはユーザーの個性・価値観・思考パターンを深く洞察するAIです。

【ユーザー自己紹介】
${entText}

【マイリスト（好きな作品・音楽・本）】
${listText}
${personalInfo}
【これまでの回答（重複・類似禁止）】
${answersText}

【最近の質問（重複禁止）】
${recentText}

今回の質問タイプ: 【${chosenType}】

このユーザー個人に向けた質問を1つ生成してください。

重要ルール:
・必ず具体的な作品名・人名・場面を使う（マイリストから選ぶ）
・「一般的に」「多くの人は」のような汎用表現禁止
・このユーザーの自己紹介・回答履歴・作品リスト・個人データを踏まえた、この人だけへの質問にする
・単純な好き嫌いではなく、価値観・判断基準・思考パターンが見える質問にする
・選択肢は必ずA〜D（2〜4個）・具体的な立場（「わからない」「どちらでもない」禁止）

JSONのみ:
{"text":"質問本文","choices":[{"label":"A","text":"..."},{"label":"B","text":"..."}]}`;

  const raw   = await callClaude([{ role: "user", content: prompt }], 700);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { text: "マイリストの中で、今の自分の気分に一番近い作品は？", choices: [{ label: "A", text: "静かに向き合いたい" }, { label: "B", text: "エネルギーをもらいたい" }] };
  const p = JSON.parse(match[0]);
  return { text: p.text ?? "", choices: p.choices ?? [] };
}

// ─── リアクション生成（鋭く・個性的に）─────────────────
async function generateReaction(
  question: string, answer: string, entries: Entry[], myList: ListItem[], answers: string[], model = "claude", apiKey = ""
): Promise<string> {
  const prompt = `質問: ${question}
ユーザーの回答: ${answer}

ユーザー自己紹介: ${entries.filter((e) => !e.aiSuggested).map((e) => e.text).join(" / ") || "（未入力）"}
好きな作品: ${myList.map((m) => m.title).join(", ") || "（未追加）"}
過去の回答パターン: ${answers.slice(-8).join(" / ") || "なし"}

この回答への鋭いリアクションを1〜2文で生成してください。

禁止事項:
・「なるほど」「興味深いですね」「素晴らしい視点」などの平凡な導入禁止
・「〜ですね」系の平均的な共感表現禁止
・褒めるだけのリアクション禁止

やること:
・その回答から読み取れる、本人が気づいていない傾向や矛盾を指摘する
・過去の回答と今回の回答を対比して「一貫してるな」「意外だな」を具体的に言う
・「あなたは〜を大事にしているのかもしれない」という核心をついた仮説を提示する
・ときに少し挑発的・意外な角度から切り込んでもいい

本文のみ。短く鋭く。`;
  return await callWithModel(prompt, model, apiKey, 200);
}

// ─── フォローアップ質問生成 ──────────────────────────────
async function generateFollowUp(
  originalQ: string, originalA: string, prevQAs: ExtraQA[],
  entries: Entry[], myList: ListItem[], answers: string[], model = "claude", apiKey = ""
): Promise<{ question: string; choices: Choice[] }> {
  const prevText = prevQAs.map((qa) => `Q: ${qa.question}\nA: ${qa.answer ?? "未回答"}`).join("\n\n") || "なし";
  const prompt = `元の質問: ${originalQ}
最初の回答: ${originalA}
これまでの追加会話: ${prevText}
ユーザー: ${entries.filter((e) => !e.aiSuggested).map((e) => e.text).join(" / ") || "（未入力）"}
好きな作品: ${myList.map((m) => m.title).join(", ") || "（未追加）"}

この会話をさらに深掘りする追加質問を1つ生成してください。
・最初の回答・追加会話と具体的に繋げる
・選択肢A〜B（2〜3個）必須（「わからない」禁止）

JSONのみ:
{"question":"追加質問","choices":[{"label":"A","text":"..."},{"label":"B","text":"..."}]}`;

  const raw   = await callWithModel(prompt, model, apiKey, 400);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { question: "もう少し詳しく教えてください。", choices: [{ label: "A", text: "そう思う" }, { label: "B", text: "そうでもない" }] };
  const p = JSON.parse(match[0]);
  return { question: p.question ?? "", choices: p.choices ?? [] };
}

// ─── 分析生成 ─────────────────────────────────────────────
async function generateAnalysis(
  entries: Entry[], myList: ListItem[], answers: string[], model = "claude", apiKey = ""
): Promise<{ text: string; summary: string; suggestion: string }> {
  const entText    = entries.filter((e) => !e.aiSuggested).map((e) => `- ${e.text}`).join("\n") || "（未入力）";
  const listText   = myList.map((m) => `- ${m.title}（${m.category}）`).join("\n") || "（未追加）";
  const answersText = answers.join("\n") || "なし";

  const prompt = `あなたは人間の個性・価値観を深く洞察する専門家です。

【自己紹介】
${entText}
【マイリスト】
${listText}
【フィードでの全回答】
${answersText}

以下のJSONを返してください:
{
  "summary": "一言キャッチコピー（20字以内）",
  "suggestion": "ユーザー自身が書いたような一人称の文章（30〜50字）。「私は〜」「自分は〜」で始まり、本人が普段口にしないような自分の特徴・傾向を自然な口語で表現する。質問形式・AIっぽい表現禁止。例: 「私は表面では穏やかに見られるけど、実は誰よりも結果にこだわっている」",
  "text": "性格診断レポート本文（800〜1500字）。構成: **一言で表すと** **基本的な性格傾向** **作品から読み取れる世界観・美学** **強み・特徴** **気づいていないかもしれない傾向** **一見矛盾しているが繋がっている点**。文章形式。断定を避けつつ核心を突く。最後に「もし違ったら教えてください」系の一言。"
}
JSONのみ返答。`;

  const raw   = await callWithModel(prompt, model, apiKey, 1800);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("parse error");
  const p = JSON.parse(match[0]);
  return { text: p.text ?? "", summary: p.summary ?? "", suggestion: p.suggestion ?? "" };
}

// ─── フィードカードUI ─────────────────────────────────────
function FeedCardView({ card, onAnswer, onContinue, onExtraAnswer }: {
  card:          FeedCard;
  onAnswer:      (id: string, answer: string) => void;
  onContinue:    (id: string) => void;
  onExtraAnswer: (id: string, answer: string) => void;
}) {
  const [freeText,       setFreeText]       = useState("");
  const [showFree,       setShowFree]       = useState(false);
  const [extraFreeText,  setExtraFreeText]  = useState("");
  const [showExtraFree,  setShowExtraFree]  = useState(false);

  const submit = (text: string) => {
    if (!text.trim()) return;
    onAnswer(card.id, text.trim());
    setFreeText(""); setShowFree(false); Keyboard.dismiss();
  };

  const submitExtra = (text: string) => {
    if (!text.trim()) return;
    onExtraAnswer(card.id, text.trim());
    setExtraFreeText(""); setShowExtraFree(false); Keyboard.dismiss();
  };

  const answered = !!card.answered;
  const pendingQA = card.showReply ? card.extraQAs.slice(-1)[0] : null;

  return (
    <View style={styles.feedCard}>
      {/* 質問本文 */}
        <Text style={styles.feedCardText}>
          {card.loading && !card.text ? "考えています..." : card.text}
        </Text>
        {card.loading && !card.text && (
          <ActivityIndicator size="small" color="#555" style={{ marginTop: 8 }} />
        )}

        {/* 選択肢（未回答時） */}
        {!answered && !card.loading && (
          <View style={styles.choicesWrap}>
            {card.choices.map((c) => (
              <TouchableOpacity key={c.label} style={styles.choiceBtn} onPress={() => submit(`${c.label}: ${c.text}`)}>
                <Text style={styles.choiceLabel}>{c.label}</Text>
                <Text style={styles.choiceText}>{c.text}</Text>
              </TouchableOpacity>
            ))}
            {showFree ? (
              <View style={styles.freeInputRow}>
                <TextInput style={styles.freeInput} placeholder="自由に回答..." placeholderTextColor="#555"
                  value={freeText} onChangeText={setFreeText} returnKeyType="done"
                  onSubmitEditing={() => submit(freeText)} autoFocus />
                <TouchableOpacity style={[styles.freeSubmitBtn, !freeText.trim() && styles.freeSubmitDisabled]}
                  onPress={() => submit(freeText)} disabled={!freeText.trim()}>
                  <Text style={styles.freeSubmitTxt}>送信</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity style={styles.freeBtn} onPress={() => setShowFree(true)}>
                <Text style={styles.freeBtnTxt}>自由に回答する...</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* 最初の回答（常に残す） */}
        {answered && (
          <View style={styles.answeredWrap}>
            <Text style={styles.answeredLabel}>あなたの回答</Text>
            <Text style={styles.answeredText}>{card.answered}</Text>
            {card.reaction
              ? <Text style={styles.reactionText}>{card.reaction}</Text>
              : <ActivityIndicator size="small" color="#555" style={{ marginTop: 6 }} />
            }
          </View>
        )}

        {/* 過去のフォローアップ会話 */}
        {card.extraQAs.filter((qa) => !!qa.answer).map((qa, i) => (
          <View key={i}>
            <View style={styles.followUpQWrap}>
              <Text style={styles.followUpQ}>{qa.question}</Text>
            </View>
            <View style={styles.extraAnswerWrap}>
              <Text style={styles.extraAnswerText}>{qa.answer}</Text>
              {qa.reaction && <Text style={styles.reactionText}>{qa.reaction}</Text>}
            </View>
          </View>
        ))}

        {/* 続けて会話するボタン */}
        {answered && card.reaction && !card.showReply && (
          <TouchableOpacity style={styles.continueBtn} onPress={() => onContinue(card.id)}>
            <Text style={styles.continueBtnTxt}>続けて会話する</Text>
          </TouchableOpacity>
        )}

        {/* フォローアップ質問（ローディング中） */}
        {card.showReply && !pendingQA && (
          <View style={styles.followUpLoadingRow}>
            <ActivityIndicator size="small" color="#555" />
            <Text style={styles.followUpLoadingTxt}>追加質問を考えています...</Text>
          </View>
        )}

        {/* フォローアップ質問と選択肢 */}
        {pendingQA && !pendingQA.answer && (
          <View>
            <View style={styles.followUpQWrap}>
              <Text style={styles.followUpQ}>{pendingQA.question}</Text>
            </View>
            <View style={styles.choicesWrap}>
              {pendingQA.choices.map((c) => (
                <TouchableOpacity key={c.label} style={[styles.choiceBtn, styles.choiceBtnSub]}
                  onPress={() => submitExtra(`${c.label}: ${c.text}`)}>
                  <Text style={styles.choiceLabel}>{c.label}</Text>
                  <Text style={styles.choiceText}>{c.text}</Text>
                </TouchableOpacity>
              ))}
              {showExtraFree ? (
                <View style={styles.freeInputRow}>
                  <TextInput style={styles.freeInput} placeholder="自由に回答..." placeholderTextColor="#555"
                    value={extraFreeText} onChangeText={setExtraFreeText} returnKeyType="done"
                    onSubmitEditing={() => submitExtra(extraFreeText)} autoFocus />
                  <TouchableOpacity style={[styles.freeSubmitBtn, !extraFreeText.trim() && styles.freeSubmitDisabled]}
                    onPress={() => submitExtra(extraFreeText)} disabled={!extraFreeText.trim()}>
                    <Text style={styles.freeSubmitTxt}>送信</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity style={styles.freeBtn} onPress={() => setShowExtraFree(true)}>
                  <Text style={styles.freeBtnTxt}>自由に回答する...</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        {/* 回答済みフォローアップ後に再度続けるボタン */}
        {pendingQA?.answer && pendingQA.reaction && (
          <TouchableOpacity style={styles.continueBtn} onPress={() => onContinue(card.id)}>
            <Text style={styles.continueBtnTxt}>さらに会話する</Text>
          </TouchableOpacity>
        )}
    </View>
  );
}

// ─── UsageDisplay ────────────────────────────────────────
function UsageDisplay({ stats, model }: {
  stats: { gemini: { minuteRequests: number; minuteStart: number }; claude: { inputTokens: number; outputTokens: number; cost: number }; openai: { inputTokens: number; outputTokens: number; cost: number } };
  model: string;
}) {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (model === "gemini") {
    const used = stats.gemini.minuteRequests;
    const FREE_LIMIT = 20;
    // スライディングウィンドウ: 最古のリクエストから60秒後にリセット
    const timestamps = (stats.gemini as any).timestamps as number[] ?? [];
    // 過去60秒以内のタイムスタンプだけカウント
    const validTs = timestamps.filter((t) => now - t < 60000);
    const actualUsed = validTs.length;
    const firstRequest = validTs.length > 0 ? validTs[0] : 0;
    const resetIn = firstRequest > 0 ? Math.max(0, Math.ceil((firstRequest + 60000 - now) / 1000)) : 0;
    return (
      <View style={usageStyles.wrap}>
        <Text style={usageStyles.row}>{actualUsed + "/" + FREE_LIMIT}</Text>
        <Text style={usageStyles.sub}>{resetIn > 0 ? "残" + resetIn + "s" : "利用可"}</Text>
      </View>
    );
  }

  if (model === "groq") {
    return (
      <View style={usageStyles.wrap}>
        <Text style={usageStyles.row}>Groq</Text>
        <Text style={usageStyles.sub}>無料</Text>
      </View>
    );
  }
  const data = model === "openai" ? stats.openai : stats.claude;
  const tok = data.inputTokens + data.outputTokens;
  return (
    <View style={usageStyles.wrap}>
      <Text style={usageStyles.row}>{tok > 1000 ? (tok / 1000).toFixed(1) + "k tok" : tok + " tok"}</Text>
      <Text style={usageStyles.sub}>{"$" + data.cost.toFixed(3)}</Text>
    </View>
  );
}
const usageStyles = StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  row:  { color: "#333", fontSize: 11, fontWeight: "600" },
  sub:  { color: "#2a2a2a", fontSize: 9 },
});

// ─── AnimatedActionButton ────────────────────────────────
function AnimatedActionButton({ label, onPress, disabled, loading }: {
  label: string; onPress: () => void; disabled: boolean; loading: boolean;
}) {
  const shimmer = React.useRef(new Animated.Value(0)).current;
  React.useEffect(() => {
    const anim = Animated.loop(Animated.sequence([
      Animated.timing(shimmer, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
      Animated.timing(shimmer, { toValue: 0, duration: 1400, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
    ]));
    anim.start();
    return () => anim.stop();
  }, []);
  const borderColor = shimmer.interpolate({ inputRange: [0, 1], outputRange: ["#ffffff", "#888888"] });
  const textColor   = shimmer.interpolate({ inputRange: [0, 1], outputRange: ["#ffffff", "#aaaaaa"] });
  if (loading) return <View style={styles.actionBtn}><ActivityIndicator size="small" color="#555" /></View>;
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled} activeOpacity={0.7}>
      <Animated.View style={[styles.actionBtn, { borderColor }]}>
        <Animated.Text style={[styles.actionBtnText, { color: textColor }]}>{label}</Animated.Text>
      </Animated.View>
    </TouchableOpacity>
  );
}

// ─── ペルソナグリッド（ドラッグ選択対応）────────────────────
function PersonaGrid({ chatPersona, onSelect }: {
  chatPersona: StyleId;
  onSelect: (style: StyleId) => void;
}) {
  const [tempStyle, setTempStyle] = useState<StyleId>(chatPersona);

  return (
    <View style={styles.personaPickerWrap}>
      <Text style={styles.personaPickerSection}>相手AIの口調</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 12, marginBottom: 10 }}>
        {AI_STYLES.map((s) => (
          <TouchableOpacity
            key={s.id}
            style={[styles.personaChip, tempStyle === s.id && styles.personaChipActive]}
            onPress={() => setTempStyle(s.id)}
            activeOpacity={0.6}
          >
            <Text style={[styles.personaChipText, tempStyle === s.id && { color: "#fff", fontWeight: "700" }]}>{s.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={{ flexDirection: "row", gap: 10, paddingHorizontal: 12, paddingBottom: 12 }}>
        <View style={{ flex: 1, backgroundColor: "#0a0f1a", borderRadius: 8, padding: 10 }}>
          <Text style={{ color: "#333", fontSize: 10, lineHeight: 16 }} numberOfLines={3}>
            {AI_STYLES.find((s) => s.id === tempStyle)?.prompt.split("\n")[0] ?? ""}
          </Text>
        </View>
        <TouchableOpacity
          style={{ backgroundColor: "#fff", borderRadius: 10, paddingHorizontal: 16, paddingVertical: 8, justifyContent: "center" }}
          onPress={() => onSelect(tempStyle)}
        >
          <Text style={{ color: "#000", fontWeight: "700", fontSize: 13 }}>決定</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── ドラッグ選択タブ ─────────────────────────────────────
function DragSelectTabs({ tabs, activeTab, onSelect, chatLoading }: {
  tabs: { key: string; label: string }[];
  activeTab: string;
  onSelect: (key: string) => void;
  chatLoading?: boolean;
}) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const tabLayouts = React.useRef<{ key: string; x: number; width: number }[]>([]);
  const containerX = React.useRef(0);

  const getKeyAtX = (px: number) => {
    const rx = px - containerX.current;
    return tabLayouts.current.find((t) => rx >= t.x && rx <= t.x + t.width)?.key ?? null;
  };

  return (
    <View
      style={{ flex: 1, flexDirection: "row", paddingHorizontal: 12, gap: 8 }}
      onLayout={(e) => { containerX.current = e.nativeEvent.layout.x; }}
      onStartShouldSetResponder={() => true}
      onResponderGrant={(e) => {
        const key = getKeyAtX(e.nativeEvent.pageX);
        if (key) setHoveredKey(key);
      }}
      onResponderMove={(e) => {
        const key = getKeyAtX(e.nativeEvent.pageX);
        setHoveredKey(key);
      }}
      onResponderRelease={(e) => {
        const key = getKeyAtX(e.nativeEvent.pageX);
        if (key) onSelect(key);
        setHoveredKey(null);
      }}
      onResponderTerminate={() => setHoveredKey(null)}
    >
      {tabs.map((tab, i) => {
        const isActive  = activeTab === tab.key;
        const isHovered = hoveredKey === tab.key;
        return (
          <View
            key={tab.key}
            onLayout={(e) => {
              tabLayouts.current[i] = { key: tab.key, x: e.nativeEvent.layout.x, width: e.nativeEvent.layout.width };
            }}
            style={[
              { paddingHorizontal: 18, paddingVertical: 8, borderRadius: 20, backgroundColor: "#1a1a1a", borderWidth: 1, borderColor: "#2a2a2a" },
              isActive  && { backgroundColor: "#fff", borderColor: "#fff" },
              isHovered && !isActive && { backgroundColor: "#2a2a2a", borderColor: "#555" },
            ]}
          >
            <Text style={[
              { color: "#666", fontSize: 13, fontWeight: "600" },
              isActive && { color: "#000" },
              isHovered && !isActive && { color: "#ccc" },
            ]}>
              {tab.label}
              {tab.key === "chat" && chatLoading ? " ●" : ""}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// ─── メイン ───────────────────────────────────────────────
export default function AIScreen() {
  const insets = useSafeAreaInsets();

  const [activeTab,       setActiveTab]       = useState<"chat" | "feed" | "analysis">("chat");
  const [feedCards,       setFeedCards]       = useState<FeedCard[]>([]);
  const [entries,         setEntries]         = useState<Entry[]>([]);
  const [myList,          setMyList]          = useState<ListItem[]>([]);
  const [answers,         setAnswers]         = useState<string[]>([]);
  const [generating,      setGenerating]      = useState(false);
  const [analyses,        setAnalyses]        = useState<AnalysisRecord[]>([]);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [showHistory,     setShowHistory]     = useState(false);
  const [personalContext,  setPersonalContext]  = useState<string>("");
  const [userAiPersona,   setUserAiPersona]   = useState<string>("");
  // ── AI対話 state ──
  const [chatMessages,  setChatMessages]  = useState<ChatMessage[]>([]);
  const [chatTopic,     setChatTopic]     = useState(""); // 最初の話題入力用
  const [chatLoading,   setChatLoading]   = useState(false);
  const [chatPersona,   setChatPersona]   = useState<PersonaId>("contrarian");
  const [showPersonaPicker, setShowPersonaPicker] = useState(false);
  const [chatStarted,   setChatStarted]   = useState(false); // 会話開始済み
  const [chatPaused,    setChatPaused]    = useState(false); // ユーザー許可待ち
  const [chatTurnCount, setChatTurnCount] = useState(0);     // 現在のターン数
  const [aiModel,         setAiModel]         = useState("claude");
  const [chatHistory,     setChatHistory]     = useState<ChatSession[]>([]);
  const [chatSessionId,   setChatSessionId]   = useState<string>("");
  const [showChatHistory, setShowChatHistory] = useState(false);
  // chatToneは廃止（StyleIdに統合）
  const [chatWaitingMsg,  setChatWaitingMsg]  = useState("");
  const [usageStats,      setUsageStats]      = useState<{
    gemini: { minuteRequests: number; minuteStart: number; totalRequests: number };
    claude:  { inputTokens: number; outputTokens: number; cost: number };
    openai:  { inputTokens: number; outputTokens: number; cost: number };
  } | null>(null);
  // この会話セッションのトークン数（mount時にリセット）
  const sessionTokensRef = React.useRef({ inputTokens: 0, outputTokens: 0 });
  const chatScrollRef       = React.useRef<ScrollView>(null);
  const isUserScrollingRef   = React.useRef(false);
  const [topicGenerating, setTopicGenerating] = useState(false);
  // クロージャ問題を回避するためrefでも保持
  const aiModelRef     = React.useRef(aiModel);
  const chatPersonaRef = React.useRef<StyleId>(chatPersona);
  const abortRef       = React.useRef(false);
  const apiKeysRef     = React.useRef<Record<string,string>>({ claude: '', gemini: '', openai: '', groq: '' });
  const chatTopicRef   = React.useRef(chatTopic);
  // apiKeyRefは常に現在のモデルに対応するキーを動的に返す
  const apiKeyRef = React.useMemo(() => ({
    get current() { return apiKeysRef.current[aiModelRef.current as 'claude'|'gemini'|'openai'|'groq'] ?? ''; },
    set current(_: string) {},
  }), []);
  React.useEffect(() => { aiModelRef.current     = aiModel;     }, [aiModel]);
  React.useEffect(() => { chatPersonaRef.current = chatPersona; }, [chatPersona]);
  React.useEffect(() => { chatTopicRef.current   = chatTopic;   }, [chatTopic]);

  // ── データ読み込み ──
  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem("home_entries"),
      AsyncStorage.getItem("myworld_list"),
      AsyncStorage.getItem(FEED_KEY),
      AsyncStorage.getItem(ANSWERS_KEY),
      AsyncStorage.getItem(ANALYSIS_KEY),
      AsyncStorage.getItem("personal_context"),
      AsyncStorage.getItem(CHAT_HISTORY_KEY),
      AsyncStorage.getItem(MODEL_KEY),
      AsyncStorage.getItem(APIKEY_CLAUDE),
      AsyncStorage.getItem(APIKEY_GEMINI),
      AsyncStorage.getItem(APIKEY_OPENAI),
      AsyncStorage.getItem(APIKEY_GROQ),
      AsyncStorage.getItem("user_ai_persona"),
    ]).then(([e, m, f, a, an, pc, ch, mod, kCl, kGe, kOp, kGr, persona]) => {
      if (e)   try { setEntries(JSON.parse(e));      } catch {}
      if (m)   try { setMyList(JSON.parse(m));        } catch {}
      if (f)   try { setFeedCards(JSON.parse(f));     } catch {}
      if (a)   try { setAnswers(JSON.parse(a));       } catch {}
      if (an)  try { setAnalyses(JSON.parse(an));     } catch {}
      if (pc)  setPersonalContext(pc);
      if (ch)  try { setChatHistory(JSON.parse(ch));  } catch {}
      if (mod) setAiModel(mod);
      apiKeysRef.current = { claude: kCl ?? "", gemini: kGe ?? "", openai: kOp ?? "", groq: kGr ?? "" };
      if (persona) setUserAiPersona(persona);
    });
    // chatEngineの変化を購読
    // ※ onMessageコールバックでリアルタイム更新するのでここはloading/error/pausedのみ
    const unsub = chatEngine.subscribe(async () => {
      const s = await chatEngine.getState();
      setChatWaitingMsg(s.waitingMsg ?? "");
      setChatLoading(s.loading);
      if (!s.loading) {
        setChatPaused(true);
        if (s.turnCount > 0) setChatTurnCount(s.turnCount);
        if (s.messages.length > 0) {
          // 完了時にcleanなメッセージで確定
          setChatMessages(s.messages.map((m: any) => ({ ...m, streaming: false })));
        }
      }
      if (s.error && s.error.length > 0) {
        setChatMessages((prev: any[]) => {
          const errMsg = "エラー: " + s.error;
          if (prev[prev.length-1]?.text === errMsg) return prev;
          return [...prev, { role: "other", text: errMsg }];
        });
        setChatPaused(true);
        setChatLoading(false);
      }
    });
    return unsub;
  }, []);

  // タブに戻るたびにchatEngineの最新状態を反映
  // タブに戻るたびにchatEngineの最新状態を反映
  useFocusEffect(
    React.useCallback(() => {
      chatEngine.getState().then((s) => {
        if (s.messages.length > 0) {
          const clean = s.messages.map((m: any) => ({ ...m, streaming: false }));
          setChatMessages(clean);
          setChatStarted(true);
          setChatPaused(!s.loading);
          setChatLoading(s.loading);
          setChatTurnCount(s.turnCount);
          setChatWaitingMsg(s.waitingMsg ?? "");
          if (s.topic) setChatTopic(s.topic);
          if (s.personaId) setChatPersona(s.personaId as any);
  
          if (s.sessionId) setChatSessionId(s.sessionId);
        setTimeout(() => chatScrollRef.current?.scrollToEnd({ animated: false }), 150);
        }
      });
    }, [])
  );


  // ── usage定期更新（会話タブ表示中）──
  useEffect(() => {
    const refresh = () => {
      AsyncStorage.getItem("ai_usage_stats").then((j) => {
        if (j) try { setUsageStats(JSON.parse(j)); } catch {}
      });
    };
    refresh();
    const t = setInterval(refresh, 500);
    return () => clearInterval(t);
  }, []);

  // ── 永続化 ──
  useEffect(() => {
    const done = feedCards.filter((c) => !c.loading);
    if (done.length > 0) AsyncStorage.setItem(FEED_KEY, JSON.stringify(done));
  }, [feedCards]);

  // 会話stateをリアルタイム保存（タブ切り替え対策）
  useEffect(() => {
    if (chatMessages.length === 0) return;
    const session = {
      messages: chatMessages,
      topic: chatTopic,
      started: chatStarted,
      paused: chatPaused,
      turnCount: chatTurnCount,
      sessionId: chatSessionId,
      persona: chatPersona,
      tone: "",
    };
    AsyncStorage.setItem(CHAT_SESSION_KEY, JSON.stringify(session));
  }, [chatMessages, chatPaused, chatStarted]);
  useEffect(() => { AsyncStorage.setItem(ANSWERS_KEY, JSON.stringify(answers)); }, [answers]);
  useEffect(() => {
    if (analyses.length > 0) AsyncStorage.setItem(ANALYSIS_KEY, JSON.stringify(analyses));
  }, [analyses]);

  // 自動生成は無効化（ボタン押下のみ）

  // ── 位置情報・時間帯を個人コンテキストとして取得 ──
  useEffect(() => {
    (async () => {
      try {
        const { Location } = await import("expo-location");
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === "granted") {
          const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low });
          const geo = await Location.reverseGeocodeAsync(loc.coords);
          const place = geo[0];
          const hour  = new Date().getHours();
          const timeZone = hour < 5 ? "深夜" : hour < 10 ? "午前" : hour < 14 ? "昼" : hour < 18 ? "午後" : hour < 22 ? "夜" : "深夜";
          const ctx = [
            place?.city && `現在地: ${place.city}${place.region ? "（" + place.region + "）" : ""}`,
            `現在時刻帯: ${timeZone}`,
          ].filter(Boolean).join("\n");
          setPersonalContext(ctx);
        }
      } catch {}
    })();
  }, []);

  // ── カード追加 ──
  const addCard = useCallback(async () => {
    if (generating) return;
    setGenerating(true);
    const pid = `card_${Date.now()}`;
    setFeedCards((prev) => [...prev, {
      id: pid, text: "", choices: [], extraQAs: [], showReply: false, createdAt: Date.now(), loading: true,
    }]);
    try {
      const result = await generateQuestion(entries, myList, feedCards, answers, personalContext || undefined, aiModelRef.current, apiKeyRef.current);
      setFeedCards((prev) => prev.map((c) => c.id === pid
        ? { ...c, text: result.text, choices: result.choices, loading: false }
        : c
      ));
    } catch {
      setFeedCards((prev) => prev.filter((c) => c.id !== pid));
    } finally { setGenerating(false); }
  }, [generating, entries, myList, feedCards, answers]);

  // ── 回答処理 ──
  const handleAnswer = useCallback(async (cardId: string, answer: string) => {
    const card      = feedCards.find((c) => c.id === cardId);
    const record    = `Q: ${card?.text ?? ""} → A: ${answer}`;
    const newAnswers = [...answers, record];
    setAnswers(newAnswers);
    setFeedCards((prev) => prev.map((c) => c.id === cardId ? { ...c, answered: answer } : c));
    try {
      const reaction = await generateReaction(card?.text ?? "", answer, entries, myList, newAnswers, aiModelRef.current, apiKeyRef.current);
      setFeedCards((prev) => prev.map((c) => c.id === cardId ? { ...c, reaction } : c));
    } catch {}
  }, [feedCards, entries, myList, answers]);

  // ── 続けて会話する ──
  const handleContinue = useCallback(async (cardId: string) => {
    const card = feedCards.find((c) => c.id === cardId);
    if (!card) return;
    setFeedCards((prev) => prev.map((c) => c.id === cardId ? { ...c, showReply: true } : c));
    try {
      const { question, choices } = await generateFollowUp(
        card.text, card.answered ?? "", card.extraQAs, entries, myList, answers, aiModelRef.current, apiKeyRef.current
      );
      const newQA: ExtraQA = { question, choices };
      setFeedCards((prev) => prev.map((c) => c.id === cardId
        ? { ...c, extraQAs: [...c.extraQAs, newQA] }
        : c
      ));
    } catch {}
  }, [feedCards, entries, myList, answers]);

  // ── フォローアップ回答 ──
  const handleExtraAnswer = useCallback(async (cardId: string, answer: string) => {
    const card = feedCards.find((c) => c.id === cardId);
    if (!card) return;
    const lastIdx = card.extraQAs.length - 1;
    // 回答を即時反映
    setFeedCards((prev) => prev.map((c) => {
      if (c.id !== cardId) return c;
      const newQAs = c.extraQAs.map((qa, i) => i === lastIdx ? { ...qa, answer } : qa);
      return { ...c, extraQAs: newQAs, showReply: false };
    }));
    // 回答記録
    const qa       = card.extraQAs[lastIdx];
    const record   = `追加Q: ${qa.question} → A: ${answer}`;
    const newAns   = [...answers, record];
    setAnswers(newAns);
    // リアクション生成
    try {
      const reaction = await generateReaction(qa.question, answer, entries, myList, newAns, aiModelRef.current, apiKeyRef.current);
      setFeedCards((prev) => prev.map((c) => {
        if (c.id !== cardId) return c;
        const newQAs = c.extraQAs.map((q, i) => i === lastIdx ? { ...q, reaction } : q);
        return { ...c, extraQAs: newQAs };
      }));
    } catch {}
  }, [feedCards, entries, myList, answers]);

  // ── スワイプでスキップ ──
  const handleSkip = useCallback((cardId: string) => {
    // スキップしたカードを削除して新しいカードを追加
    setFeedCards((prev) => prev.filter((c) => c.id !== cardId));
    // 自動生成なし
  }, [addCard]);

  // ── 分析実行 ──
  const runAnalysis = useCallback(async () => {
    if (analysisLoading || answers.length < 3) return;
    setAnalysisLoading(true);
    try {
      const result = await generateAnalysis(entries, myList, answers, aiModelRef.current, apiKeyRef.current);
      const record: AnalysisRecord = {
        id: `an_${Date.now()}`, text: result.text, summary: result.summary, createdAt: Date.now(),
      };
      setAnalyses((prev) => [record, ...prev]);
      // indexにAI提案を追加（朱色）
      const suggestion: Entry = { id: `ai_sug_${Date.now()}`, text: result.suggestion, aiSuggested: true };
      const updated = [...entries, suggestion];
      setEntries(updated);
      await AsyncStorage.setItem("home_entries", JSON.stringify(updated));
    } catch {
      alert("分析に失敗しました。回答を増やしてから試してください。");
    } finally { setAnalysisLoading(false); }
  }, [analysisLoading, entries, myList, answers]);

  // ── ユーザーの個性コンテキストを組み立て ──
  const buildUserContext = useCallback(() => {
    const entText   = entries.filter((e) => !e.aiSuggested).map((e) => e.text).join(" / ") || "";
    const allWorks  = myList.filter((m) => m.category !== "music");
    const music     = myList.filter((m) => m.category === "music");

    // カテゴリ別に集計して突出ジャンルを抽出
    const catCount: Record<string, string[]> = {};
    allWorks.forEach((m) => {
      if (!catCount[m.category]) catCount[m.category] = [];
      catCount[m.category].push(m.title);
    });
    // 最多カテゴリTOP2を「突出」として扱う
    const sortedCats = Object.entries(catCount).sort((a, b) => b[1].length - a[1].length);
    const topCat1 = sortedCats[0];
    const topCat2 = sortedCats[1];

    // 全作品からランダムに3件を「今日の素材」として選ぶ
    const shuffledWorks = [...allWorks].sort(() => Math.random() - 0.5).slice(0, 3);
    const shuffledMusic = [...music].sort(() => Math.random() - 0.5).slice(0, 2);

    const analysis   = analyses[0]?.text?.slice(0, 300) ?? "";
    const summary    = analyses[0]?.summary ?? "";

    return [
      entText ? `【自己紹介】${entText}` : "",
      topCat1 ? `【最も突出した趣味】${topCat1[0]}（${topCat1[1].length}作品）: ${topCat1[1].slice(0, 5).join(", ")}` : "",
      topCat2 ? `【次に強い趣味】${topCat2[0]}: ${topCat2[1].slice(0, 3).join(", ")}` : "",
      shuffledMusic.length > 0 ? `【音楽】${shuffledMusic.map((m) => m.title).join(", ")}` : "",
      `【今日の会話素材（絡めてOK）】${shuffledWorks.map((m) => m.title).join(", ")}`,
      summary ? `【このユーザーの本質】${summary}` : "",
      analysis ? `【突出した傾向】${analysis}` : "",
      personalContext ? `【状況】${personalContext}` : "",
    ].filter(Boolean).join("\n");
  }, [entries, myList, answers, analyses, personalContext]);

  // ── ターンブロック実行（ストリーミング）──
  const runBlock = useCallback(async (startMessages: ChatMessage[], startTurn: number): Promise<ChatMessage[]> => {
    const persona  = AI_PERSONAS.find((p) => p.id === chatPersonaRef.current) ?? AI_PERSONAS[0];
    const userCtx  = buildUserContext();
    const topic    = chatTopicRef.current; // 議題を常に参照
    let accumulated = [...startMessages];

    abortRef.current = false;
    for (let t = 0; t < TURNS_PER_BLOCK; t++) {
      if (abortRef.current) break;

      const history = accumulated
        .filter((m) => m.role !== "topic")
        .slice(-4)
        .map((m) => (m.role === "you" ? "あなたAI" : persona.label) + ": " + m.text)
        .join(" / ");

      // ── あなたAI（ストリーミング）──
      const youId = "you_" + Date.now();
      const youPlaceholder: ChatMessage = { role: "you", text: "", streaming: true };
      accumulated = [...accumulated, youPlaceholder];
      setChatMessages((prev) => [...prev, youPlaceholder]);

      // あなたAIのキャラ：設定優先 → なければMyWorldデータから突出した傾向で尖ったキャラを生成
      const youCharaDef = userAiPersona
        ? "あなたは以下の設定のキャラクターです: " + userAiPersona
        : userCtx
        ? "以下のデータから「最も突出した傾向」だけを抽出して尖ったキャラを作れ。平均化・丸め禁止。" +
          "例：SF多い+哲学書 → 「実存的な問いに取り憑かれたオタク」。" +
          "データ：" + userCtx
        : "自然な口語で話す人物";

      const youPrompt =
        youCharaDef +
        " 【必須進行ルール：毎ターン全て含めること】" +
        "①キーワード（**太字**）を1つ以上出す " +
        "②トリビア・豆知識・裏話・制作秘話を1つ出す（「トリビアだと〜」「実は〜」） " +
        "③比喩かユーモアを1つ使う（「例えると〜」） " +
        "④「なぜそうなるか」を必ず説明する " +
        "⑤前の発言を受けて必ず発展させる（同じ内容の言い換え禁止） " +
        "⑥【今日の会話素材】の作品名が自然に出せる場面で絡める " +
        " 【禁止】浅い感想のみ・説明だけ・箇条書き・長文分析 " +
        " 【文体】口語・2〜3文程度 " +
        " 【議題】" + topic +
        " 【会話履歴】" + (history || "なし") +
        " 指示: 上記の人物として1〜2文で返す。議題について自分の感覚・経験から話す。";

      let youText = "";
      await pseudoStream(youPrompt, aiModelRef.current, apiKeyRef.current, (_char, full) => {
        youText = full;
        setChatMessages((prev) => prev.map((m) => m.streaming ? { ...m, text: full } : m));
      }, abortRef, 150);

      const youMsg: ChatMessage = { role: "you", text: youText };
      accumulated = [...accumulated.slice(0, -1), youMsg];
      setChatMessages((prev) => prev.map((m) => m.streaming ? { ...m, streaming: false } : m));
      if (abortRef.current) break;
      await new Promise((r) => setTimeout(r, 300));

      // ── 相手AI（ストリーミング）──
      const otherPlaceholder: ChatMessage = { role: "other", text: "", streaming: true };
      accumulated = [...accumulated, otherPlaceholder];
      setChatMessages((prev) => [...prev, otherPlaceholder]);

      const otherPrompt =
        buildPersonaPrompt(chatPersonaRef.current) +
        " 【必須進行ルール：毎ターン全て含めること】" +
        "①キーワード（**太字**）を1つ以上出す " +
        "②トリビア・豆知識・裏話・制作秘話を1つ出す（「トリビアとして〜」「実は〜」） " +
        "③比喩かユーモアを1つ使う（「例えるなら〜」「まるで〜」） " +
        "④なぜそうなるかの理由を必ず説明する " +
        "⑤前の発言を受けて発展させる（同じ内容の言い換え・表面的な同意禁止） " +
        " 【禁止】浅い感想・説明だけ・長文分析・同じ言い回しの繰り返し " +
        " 【文体】口調・性格を必ず守る。2〜3文程度 " +
        " 【議題】" + topic +
        " 【会話履歴】" + history + " / あなたAI: " + youText;

      let otherText = "";
      await pseudoStream(otherPrompt, aiModelRef.current, apiKeyRef.current, (_char, full) => {
        otherText = full;
        setChatMessages((prev) => prev.map((m) => m.streaming ? { ...m, text: full } : m));
      }, abortRef, 150);

      const otherMsg: ChatMessage = { role: "other", text: otherText };
      accumulated = [...accumulated.slice(0, -1), otherMsg];
      setChatMessages((prev) => prev.map((m) => m.streaming ? { ...m, streaming: false } : m));
      if (abortRef.current) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    return accumulated;
  }, [buildUserContext]);

  // ── 会話を開始 ──
  const startChat = useCallback(async () => {
    const topic = chatTopic.trim();
    if (!topic || chatLoading) return;
    const sid = "chat_" + Date.now();
    setChatSessionId(sid);
    setChatStarted(true);
    setChatPaused(false);
    setChatTurnCount(0);
    setChatLoading(true);
    Keyboard.dismiss();

    const topicMsg: ChatMessage = { role: "topic", text: topic };
    setChatMessages([topicMsg]);

    const persona   = AI_PERSONAS.find((p) => p.id === chatPersona) ?? AI_PERSONAS[0];
    const personaPr = buildPersonaPrompt(chatPersonaRef.current);
    const curModel  = aiModelRef.current;
    const curKeys   = { ...apiKeysRef.current };

    console.log("[startChat] model:", curModel, "keys:", { claude: curKeys.claude?.length, gemini: curKeys.gemini?.length, openai: curKeys.openai?.length, groq: curKeys.groq?.length });
    await chatEngine.setState({
      messages: [topicMsg], topic, started: true, paused: false,
      loading: true, turnCount: 0, sessionId: sid,
      personaId: chatPersona, toneId: "", error: "", waitingMsg: "",
    });

    const updateMsg = (msg: any) => {
      setChatMessages((prev) => {
        // streaming更新: 同じroleのstreaming中のメッセージを置き換え
        if (msg.streaming) {
          const lastStreamingIdx = [...prev].reverse().findIndex((m) => m.streaming && m.role === msg.role);
          if (lastStreamingIdx >= 0) {
            const idx = prev.length - 1 - lastStreamingIdx;
            const next = [...prev];
            next[idx] = msg;
            return next;
          }
          // streaming開始（空テキスト）
          return [...prev, msg];
        }
        // streaming完了: 最後のstreaming要素を確定版に置き換え
        const lastStreamingIdx = [...prev].reverse().findIndex((m) => m.streaming && m.role === msg.role);
        if (lastStreamingIdx >= 0) {
          const idx = prev.length - 1 - lastStreamingIdx;
          const next = [...prev];
          next[idx] = { ...msg, streaming: false };
          return next;
        }
        return [...prev, { ...msg, streaming: false }];
      });
    };
    chatEngine.runTurns(curModel, curKeys, personaPr, TURNS_PER_BLOCK, updateMsg, buildUserContext(), userAiPersona)
    .then(async () => {
      const s = await chatEngine.getState();
      const clean = s.messages.map((m: any) => ({ ...m, streaming: false }));
      setChatMessages(clean);
      setChatTurnCount(s.turnCount);
      setChatPaused(true);
      setChatLoading(false);
      const session: ChatSession = { id: sid, topic, messages: clean, personaId: chatPersona, createdAt: Date.now() };
      const newHistory = [session, ...chatHistory].slice(0, 20);
      setChatHistory(newHistory);
      await AsyncStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(newHistory));
    }).catch((e: any) => {
      setChatMessages((prev) => [...prev, { role: "other", text: "エラー: " + (e?.message ?? String(e)) }]);
      setChatPaused(true);
      setChatLoading(false);
    });
  }, [chatTopic, chatLoading, chatPersona, chatHistory, buildUserContext]);

  // ── 続きを許可 ──
  const continueChat = useCallback(async () => {
    if (chatLoading) return;
    setChatPaused(false);
    setChatLoading(true);

    const personaPr = buildPersonaPrompt(chatPersonaRef.current);
    const curModel  = aiModelRef.current;
    const curKeys   = { ...apiKeysRef.current };

    await chatEngine.setState({ loading: true, paused: false, waitingMsg: "" });

    const updateMsg2 = (msg: any) => {
      setChatMessages((prev) => {
        if (msg.streaming) {
          const lastStreamingIdx = [...prev].reverse().findIndex((m) => m.streaming && m.role === msg.role);
          if (lastStreamingIdx >= 0) {
            const idx = prev.length - 1 - lastStreamingIdx;
            const next = [...prev];
            next[idx] = msg;
            return next;
          }
          return [...prev, msg];
        }
        const lastStreamingIdx = [...prev].reverse().findIndex((m) => m.streaming && m.role === msg.role);
        if (lastStreamingIdx >= 0) {
          const idx = prev.length - 1 - lastStreamingIdx;
          const next = [...prev];
          next[idx] = { ...msg, streaming: false };
          return next;
        }
        return [...prev, { ...msg, streaming: false }];
      });
    };
    chatEngine.runTurns(curModel, curKeys, personaPr, TURNS_PER_BLOCK, updateMsg2, buildUserContext(), userAiPersona)
    .then(async () => {
      const s = await chatEngine.getState();
      const clean = s.messages.map((m: any) => ({ ...m, streaming: false }));
      setChatMessages(clean);
      setChatTurnCount(s.turnCount);
      setChatPaused(true);
      setChatLoading(false);
      const updated = chatHistory.map((ses) => ses.id === chatSessionId ? { ...ses, messages: clean } : ses);
      setChatHistory(updated);
      await AsyncStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(updated));
    }).catch((e: any) => {
      setChatMessages((prev) => [...prev, { role: "other", text: "エラー: " + (e?.message ?? String(e)) }]);
      setChatPaused(true);
      setChatLoading(false);
    });
  }, [chatLoading, chatSessionId, chatHistory, buildUserContext]);



  // ── トピックをランダム生成 ──
  const generateTopic = useCallback(async () => {
    if (topicGenerating) return;
    setTopicGenerating(true);
    const userCtx = buildUserContext();
    // MyWorldデータからランダムに1〜2件だけ選ぶ（偏り防止）
    const allTitles = myList.filter((m) => m.category !== "music").map((m) => m.title);
    const shuffled = allTitles.sort(() => Math.random() - 0.5);
    const listSample = shuffled.slice(0, 2).join("、"); // 最大2件
    const musicSample = myList.filter((m) => m.category === "music")
      .sort(() => Math.random() - 0.5).slice(0, 1).map((m) => m.title).join("、"); // 最大1件
    const entrySample = entries.filter((e) => !e.aiSuggested)
      .sort(() => Math.random() - 0.5).slice(0, 2).map((e) => e.text).join("、");
    const types = ["もし〜だったら？形式","〜と〜どちらが好き？形式","なぜ〜が好きなの？形式","〜についてどう思う？形式","〜の場面で自分はどうする？形式","仮定の状況形式","価値観を問う形式","逆説的な問い形式"];
    const chosenType = types[Math.floor(Math.random() * types.length)];
    const prompt = "ユーザーの情報をもとにAI同士の会話トピックを1つ生成。毎回違うテーマにする。" +
      (listSample ? "参考（使わなくてもよい）: " + listSample + "。" : "") +
      (musicSample ? "音楽参考: " + musicSample + "。" : "") +
      (entrySample ? "自己紹介: " + entrySample + "。" : "") +
      "形式: " + chosenType + "。具体的・ユニーク。25字以内。トピック文のみ:";
    try {
      const res2 = await (async () => {
        if (aiModelRef.current === "gemini") {
          const key = apiKeyRef.current;
          if (!key) throw new Error("GeminiのAPIキーが未設定です");
          for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) await new Promise((r2) => setTimeout(r2, 3000));
            const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=" + key,
              { method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 80, thinkingConfig: { thinkingBudget: 0 } } }) });
            if (r.status === 429) { if (attempt === 2) throw new Error("Gemini 429: しばらく待ってから試してください"); continue; }
            if (!r.ok) { const d = await r.json(); throw new Error("Gemini " + r.status); }
            recordGeminiRequest().catch(() => {});
            const d = await r.json();
            return d.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
          }
          return "";
        } else if (aiModelRef.current === "openai") {
          const key = apiKeyRef.current || process.env.EXPO_PUBLIC_OPENAI_API_KEY || "";
          const r = await fetch("https://api.openai.com/v1/chat/completions",
            { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key }, body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], max_tokens: 80 }) });
          const d = await r.json(); return d.choices?.[0]?.message?.content?.trim() ?? "";
        } else if (aiModelRef.current === "groq") {
          const key = apiKeyRef.current;
          if (!key) throw new Error("GroqのAPIキーが未設定です");
          const r = await fetch("https://api.groq.com/openai/v1/chat/completions",
            { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
              body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }], max_tokens: 80 }) });
          const d = await r.json();
          if (!r.ok) throw new Error("Groq " + r.status);
          return d.choices?.[0]?.message?.content?.trim() ?? "";
        } else {
          return await callClaude([{ role: "user", content: prompt }], 80);
        }
      })();
      if (res2) setChatTopic(res2.replace(/^「|」$/g, "").trim());
    } catch (e: any) {
      // エラーはtopicにセットせずアラートで表示
      alert("話題生成エラー: " + (e?.message ?? String(e)));
    } finally {
      setTopicGenerating(false);
    }
  }, [topicGenerating, buildUserContext, entries, myList]);

  // ── 中止 ──
  const abortChat = () => {
    chatEngine.abort();
    setChatLoading(false);
    setChatPaused(true);
    // 履歴windowは開かない
  };

  // ── リセット（新規開始）──
  const resetChat = () => {
    chatEngine.reset();
    setChatMessages([]);
    setChatTopic("");
    setChatStarted(false);
    setChatPaused(false);
    setChatTurnCount(0);
    setChatSessionId("");
    setChatLoading(false);
  };


  const completed      = feedCards.filter((c) => !c.loading || c.text);
  const latestAnalysis = analyses[0];

  return (
    <View style={[styles.container, { paddingTop: insets.top + 12 }]}>
      <Text style={styles.headerTitle}>AI</Text>

      {activeTab === "chat" && (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={8}>
          <View style={styles.personaBar}>
            <TouchableOpacity style={{ flex: 1, flexDirection: "row", alignItems: "center" }}
              onPress={() => setShowPersonaPicker((v) => !v)}>
              <Text style={styles.personaBarLabel}>相手AI：</Text>
              <Text style={styles.personaBarName}>{AI_STYLES.find((s) => s.id === chatPersona)?.label ?? chatPersona}</Text>
              <Text style={styles.personaBarChevron}>{showPersonaPicker ? " ▲" : " ▼"}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setShowChatHistory((v) => !v)} style={styles.chatHistoryBtn}>
              <Text style={styles.chatHistoryBtnText}>履歴</Text>
            </TouchableOpacity>
            {chatStarted && chatLoading && (
              <TouchableOpacity onPress={abortChat} style={styles.chatAbortBtn}>
                <Text style={styles.chatAbortBtnText}>中止</Text>
              </TouchableOpacity>
            )}
            {chatStarted && !chatLoading && (
              <TouchableOpacity onPress={resetChat} style={styles.chatResetBtn}>
                <Text style={styles.chatResetBtnText}>新規</Text>
              </TouchableOpacity>
            )}
          </View>

          {showPersonaPicker && (
            <PersonaGrid
              chatPersona={chatPersona}
              onSelect={(style) => { setChatPersona(style); setShowPersonaPicker(false); }}
            />
          )}

          {showChatHistory && (
            <View style={styles.chatHistoryPanel}>
              <View style={styles.chatHistoryHeader}>
                <Text style={styles.chatHistoryTitle}>過去の会話</Text>
                <TouchableOpacity onPress={() => setShowChatHistory(false)} style={{ padding: 4 }}>
                  <Text style={{ color: "#444", fontSize: 14 }}>✕</Text>
                </TouchableOpacity>
              </View>
              <ScrollView style={{ maxHeight: 200 }}>
                {chatHistory.length === 0
                  ? <Text style={styles.chatHistoryEmpty}>まだ履歴がありません</Text>
                  : chatHistory.map((s) => {
                    const persona = AI_PERSONAS.find((p) => p.id === s.personaId);
                    const date = new Date(s.createdAt).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
                    const turns = s.messages.filter((m) => m.role === "you").length;
                    return (
                      <TouchableOpacity key={s.id} style={styles.chatHistoryItem}
                        onPress={() => {
                          chatEngine.abort();
                          setChatMessages(s.messages);
                          setChatSessionId(s.id);
                          setChatPersona(s.personaId as PersonaId);
                          setChatTopic(s.topic);
                          setChatStarted(true);
                          setChatPaused(true);
                          setChatLoading(false);
                          setChatTurnCount(turns);
                          setShowChatHistory(false);
                        }}>
                        <Text style={styles.chatHistoryItemTopic} numberOfLines={2}>{s.topic}</Text>
                        <Text style={styles.chatHistoryItemMeta}>{persona?.label ?? "不明"} · {turns}ターン · {date}</Text>
                      </TouchableOpacity>
                    );
                  })
                }
              </ScrollView>
            </View>
          )}

          {!chatStarted && (
            <View style={styles.chatInputAreaTop}>
              <TextInput
                style={styles.chatInputMulti}
                placeholder="話題を入力..."
                placeholderTextColor="#555"
                value={chatTopic}
                onChangeText={setChatTopic}
                multiline
                returnKeyType="send"
                blurOnSubmit={false}
                onSubmitEditing={startChat}
              />
            </View>
          )}

          <ScrollView
            ref={chatScrollRef}
            style={{ flex: 1 }}
            contentContainerStyle={styles.chatLog}
            onScrollBeginDrag={() => { isUserScrollingRef.current = true; }}
            onMomentumScrollEnd={() => { isUserScrollingRef.current = false; }}
            onContentSizeChange={() => {
              if (!isUserScrollingRef.current) {
                chatScrollRef.current?.scrollToEnd({ animated: true });
              }
            }}
          >
            {!chatStarted && (
              <View style={styles.chatEmpty}>
                <Text style={styles.chatEmptyText}>{`AIどうしが会話します\n${TURNS_PER_BLOCK}ターンごとに確認します`}</Text>
              </View>
            )}
            {chatMessages.map((msg, i) => {
              if (msg.role === "topic") return (
                <View key={i} style={styles.chatTopicBadge}>
                  <Text style={styles.chatTopicText}>{msg.text}</Text>
                </View>
              );
              const isYou = msg.role === "you";
              return (
                <View key={i} style={[styles.chatBubbleWrap, isYou ? styles.chatBubbleWrapYou : styles.chatBubbleWrapOther]}>
                  <Text style={styles.chatBubbleRole}>{isYou ? "あなたAI" : AI_PERSONAS.find((p) => p.id === chatPersona)?.label}</Text>
                  <View style={[styles.chatBubble, isYou ? styles.chatBubbleYou : styles.chatBubbleOther]}>
                    <Text style={styles.chatBubbleText}>{msg.text}</Text>
                  </View>
                </View>
              );
            })}
            {chatLoading && (
              <View style={{ padding: 12, alignItems: "flex-start" }}>
                <ActivityIndicator size="small" color="#555" />
              </View>
            )}
          </ScrollView>

          <View style={styles.chatBottomWrap}>
            {!chatStarted && (
              <View style={styles.chatBottomActions}>
                <TouchableOpacity style={styles.chatRandBtn} onPress={generateTopic} disabled={topicGenerating}>
                  <Text style={styles.chatRandBtnText}>{topicGenerating ? "生成中..." : "ランダム"}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.chatSendBtn, chatLoading && styles.chatSendBtnDisabled]}
                  onPress={chatTopic.trim() ? startChat : generateTopic}
                  disabled={chatLoading}>
                  <Text style={styles.chatSendBtnText}>{chatTopic.trim() ? "開始" : "＋"}</Text>
                </TouchableOpacity>
              </View>
            )}
            {chatStarted && chatPaused && !chatLoading && (
              <View style={styles.chatControlInner}>
                <Text style={styles.chatTurnText}>{chatTurnCount}ターン完了</Text>
                <View style={styles.chatControlBtns}>
                  <TouchableOpacity style={styles.chatStopBtn} onPress={resetChat}>
                    <Text style={styles.chatStopBtnText}>終了</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.chatContinueBtn} onPress={continueChat}>
                    <Text style={styles.chatContinueBtnText}>続ける（+{TURNS_PER_BLOCK}ターン）</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
            {chatLoading && (
              <View style={styles.chatControlInner}>
                <Text style={styles.chatTurnText}>{chatWaitingMsg || (aiModelRef.current === "gemini" ? "会話中... (Gemini: 間隔調整中)" : "会話中...")}</Text>
              </View>
            )}
          </View>
        </KeyboardAvoidingView>
      )}

      {activeTab === "feed" && (
        <FlatList
          data={[...completed].reverse()}
          keyExtractor={(item) => item.id}
          style={styles.feedList}
          contentContainerStyle={[styles.listContent, { paddingBottom: 16 }]}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <FeedCardView card={item} onAnswer={handleAnswer} onContinue={handleContinue} onExtraAnswer={handleExtraAnswer} />
          )}
          ListEmptyComponent={generating ? <View style={styles.emptyState}><ActivityIndicator color="#fff" /><Text style={styles.emptyText}>考えています...</Text></View> : null}
        />
      )}

      {activeTab === "analysis" && (
        <ScrollView style={styles.feedList} contentContainerStyle={[styles.listContent, { paddingBottom: 16 }]}>
          {answers.length < 3 && <View style={styles.noticeCard}><Text style={styles.noticeText}>フィードで3つ以上回答すると分析できます（現在 {answers.length} 件）</Text></View>}
          {!latestAnalysis && !analysisLoading && answers.length >= 3 && <View style={styles.emptyState}><Text style={styles.emptyTitle}>性格分析</Text><Text style={styles.emptyText}>下の「分析する」ボタンを押してください</Text></View>}
          {analysisLoading && <View style={styles.emptyState}><ActivityIndicator color="#fff" size="large" /><Text style={styles.emptyText}>深く分析しています...</Text></View>}
          {latestAnalysis && (
            <>
              <View style={styles.summaryCard}>
                <Text style={styles.summaryDate}>{new Date(latestAnalysis.createdAt).toLocaleDateString("ja-JP")}</Text>
                <Text style={styles.summaryText}>{latestAnalysis.summary}</Text>
              </View>
              <View style={styles.analysisCard}>
                <Text style={styles.analysisText}>{latestAnalysis.text}</Text>
              </View>
            </>
          )}
        </ScrollView>
      )}

      {chatLoading && activeTab !== "chat" && (
        <View style={styles.chatInProgressBar}>
          <Text style={styles.chatInProgressText}>{chatWaitingMsg || "● 会話生成中..."}</Text>
          <TouchableOpacity onPress={() => setActiveTab("chat")}>
            <Text style={styles.chatInProgressLink}>確認する</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={[styles.tabBarWrap, { paddingBottom: insets.bottom + 8 }]}>
        <View style={styles.tabAndBtnRow}>
          <DragSelectTabs
            tabs={[{ key: "chat", label: "会話" }, { key: "feed", label: "フィード" }, { key: "analysis", label: "分析" }]}
            activeTab={activeTab}
            onSelect={(tab) => setActiveTab(tab as typeof activeTab)}
            chatLoading={chatLoading}
          />
          {activeTab === "feed" && <AnimatedActionButton label="次の質問" onPress={addCard} disabled={generating} loading={generating} />}
          {usageStats && activeTab === "chat" && (
            <UsageDisplay stats={usageStats} model={aiModelRef.current} />
          )}
          {activeTab === "analysis" && !latestAnalysis && answers.length >= 3 && <AnimatedActionButton label="分析する" onPress={runAnalysis} disabled={analysisLoading} loading={analysisLoading} />}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: "#000" },
  headerTitle: { color: "#fff", fontSize: 26, fontWeight: "700", paddingHorizontal: 20, marginBottom: 12 },
  feedList:    { flex: 1 },
  listContent: { paddingHorizontal: 16 },
  tabBarWrap:   { borderTopWidth: 0.5, borderTopColor: "#222", paddingTop: 10, backgroundColor: "#000" },
  tabAndBtnRow: { flexDirection: "row", alignItems: "center", paddingRight: 12 },
  actionBtn:         { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1.5, borderColor: "#fff", marginLeft: 8, backgroundColor: "transparent" },
  actionBtnDisabled: { borderColor: "#333", backgroundColor: "#1a1a1a" },
  actionBtnText:     { color: "#fff", fontSize: 13, fontWeight: "700" },
  feedCard:     { backgroundColor: "#0d0d0d", borderRadius: 16, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: "#1e1e1e" },
  feedCardText: { color: "#e0e0e0", fontSize: 15, lineHeight: 24 },
  choicesWrap:   { marginTop: 14, gap: 8 },
  choiceBtn:     { flexDirection: "row", alignItems: "flex-start", backgroundColor: "#1a1a1a", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#2a2a2a", gap: 10 },
  choiceBtnSub:  { backgroundColor: "#111", borderColor: "#222" },
  choiceLabel:   { color: "#fff", fontWeight: "700", fontSize: 14, minWidth: 20 },
  choiceText:    { color: "#ccc", fontSize: 14, lineHeight: 20, flex: 1 },
  freeBtn:       { paddingVertical: 10, alignItems: "center", borderWidth: 1, borderColor: "#2a2a2a", borderRadius: 12 },
  freeBtnTxt:    { color: "#555", fontSize: 13 },
  freeInputRow:  { flexDirection: "row", gap: 8 },
  freeInput:     { flex: 1, height: 40, backgroundColor: "#1a1a1a", borderRadius: 20, paddingHorizontal: 14, color: "#fff", fontSize: 14, borderWidth: 1, borderColor: "#333" },
  freeSubmitBtn:      { height: 40, paddingHorizontal: 14, backgroundColor: "#fff", borderRadius: 20, justifyContent: "center" },
  freeSubmitDisabled: { backgroundColor: "#333" },
  freeSubmitTxt:      { color: "#000", fontWeight: "700", fontSize: 13 },
  answeredWrap:  { marginTop: 12, backgroundColor: "#111", borderRadius: 10, padding: 12, borderLeftWidth: 2, borderLeftColor: "#333" },
  answeredLabel: { color: "#555", fontSize: 11, marginBottom: 4 },
  answeredText:  { color: "#fff", fontSize: 14, marginBottom: 8 },
  reactionText:  { color: "#aaa", fontSize: 13, lineHeight: 20, fontStyle: "italic" },
  followUpQWrap:      { marginTop: 14, backgroundColor: "#0a0a0a", borderRadius: 10, padding: 12, borderLeftWidth: 2, borderLeftColor: "#555" },
  followUpQ:          { color: "#ddd", fontSize: 14, lineHeight: 22 },
  followUpLoadingRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12, paddingVertical: 8 },
  followUpLoadingTxt: { color: "#555", fontSize: 13 },
  extraAnswerWrap:    { marginTop: 8, backgroundColor: "#111", borderRadius: 10, padding: 12, borderLeftWidth: 2, borderLeftColor: "#2a2a2a" },
  extraAnswerText:    { color: "#fff", fontSize: 14, marginBottom: 6 },
  continueBtn:    { marginTop: 12, paddingVertical: 10, alignItems: "center", borderWidth: 1, borderColor: "#333", borderRadius: 10 },
  continueBtnTxt: { color: "#666", fontSize: 13 },
  noticeCard: { backgroundColor: "#111", borderRadius: 12, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: "#2a2a2a" },
  noticeText: { color: "#666", fontSize: 13, textAlign: "center" },
  summaryCard:  { backgroundColor: "#1a0a00", borderRadius: 14, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: "#8B2500" },
  summaryDate:  { color: "#8B2500", fontSize: 11, marginBottom: 6 },
  summaryText:  { color: "#ff6b35", fontSize: 20, fontWeight: "700", lineHeight: 28 },
  analysisCard: { backgroundColor: "#0d0d0d", borderRadius: 16, padding: 20, borderWidth: 1, borderColor: "#222", marginBottom: 4 },
  analysisText: { color: "#e0e0e0", fontSize: 15, lineHeight: 28 },
  emptyState: { paddingTop: 40, alignItems: "center", gap: 12, paddingHorizontal: 16 },
  usageInline:     { paddingHorizontal: 6, paddingVertical: 4 },
  usageInlineText: { color: "#333", fontSize: 10 },
  usageCard:     { backgroundColor: "#0a0a0a", borderRadius: 12, padding: 10, borderWidth: 1, borderColor: "#1a1a1a", minWidth: 80 },
  usageCardTitle:{ color: "#333", fontSize: 9, fontWeight: "600", letterSpacing: 0.5, marginBottom: 4 },
  usageCardRow:  { color: "#2a2a2a", fontSize: 10, lineHeight: 15 },
  emptyTitle: { color: "#fff", fontSize: 18, fontWeight: "700" },
  emptyText:  { color: "#444", fontSize: 14, textAlign: "center", lineHeight: 24 },
  personaBar:       { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 0.5, borderBottomColor: "#1e1e1e", backgroundColor: "#0a0a0a" },
  personaBarLabel:  { color: "#555", fontSize: 12 },
  personaBarName:   { color: "#fff", fontSize: 12, fontWeight: "700" },
  personaBarChevron:{ color: "#555", fontSize: 11, marginLeft: 4 },
  personaPickerWrap:{ backgroundColor: "#0d0d0d", borderBottomWidth: 0.5, borderBottomColor: "#1e1e1e", paddingVertical: 10 },
  personaPickerSection: { color: "#444", fontSize: 10, fontWeight: "700", letterSpacing: 0.8, paddingHorizontal: 14, paddingBottom: 6 },
  personaPickerDesc:    { color: "#333", fontSize: 11, paddingHorizontal: 14, paddingTop: 8, lineHeight: 16 },
  personaChip:          { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: "#111", borderWidth: 1, borderColor: "#2a2a2a" },
  personaChipActive:    { backgroundColor: "#1a1a1a", borderColor: "#888" },
  personaChipToneActive:{ backgroundColor: "#0a1628", borderColor: "#1a3a6a" },
  personaChipText:      { color: "#666", fontSize: 13 },
  personaGridHeader:         { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#1a1a1a", paddingVertical: 6 },
  personaGridHeaderCell:     { flex: 1, alignItems: "center", justifyContent: "center" },
  personaGridRoleLabel:      { color: "#444", fontSize: 10, textAlign: "center" },
  personaGridRoleLabelActive:{ color: "#fff", fontWeight: "700" },
  personaGridRow:            { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#111" },
  personaGridToneCell:       { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 10 },
  personaGridToneLabel:      { color: "#444", fontSize: 11 },
  personaGridToneLabelActive:{ color: "#7eb8ff", fontWeight: "700" },
  personaGridCell:           { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 10 },
  personaGridCellActive:     { backgroundColor: "#0d1a2e", borderRadius: 6, margin: 2 },
  personaGridCellCheck:      { color: "#7eb8ff", fontSize: 14, fontWeight: "700" },
  personaGridDesc:           { padding: 12, borderTopWidth: 0.5, borderTopColor: "#1a1a1a" },
  personaGridDescText:       { color: "#444", fontSize: 11, lineHeight: 16 },
  chatTopArea:       { borderBottomWidth: 0.5, borderBottomColor: "#1e1e1e", backgroundColor: "#000" },
  chatTopInputRow:   { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 },
  chatInputAreaTop:  { paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 0.5, borderBottomColor: "#1e1e1e" },
  chatBottomActions: { flexDirection: "row", gap: 8, padding: 10, justifyContent: "flex-end", borderBottomWidth: 0.5, borderBottomColor: "#1e1e1e" },
  chatLog:          { padding: 16, gap: 20, paddingBottom: 24 },
  chatEmpty:        { paddingTop: 60, alignItems: "center" },
  chatEmptyText:    { color: "#333", fontSize: 14, textAlign: "center", lineHeight: 24 },
  chatBubbleWrap:     { gap: 4 },
  chatBubbleWrapYou:  { alignItems: "flex-end" },
  chatBubbleWrapOther:{ alignItems: "flex-start" },
  chatBubbleRole:   { color: "#3a5a7a", fontSize: 10, paddingHorizontal: 6, marginBottom: 2, fontWeight: "600" },
  chatBubble:       { maxWidth: "85%", borderRadius: 18, padding: 14, flexShrink: 1 },
  chatBubbleYou:    { backgroundColor: "#1a2a4a", borderWidth: 0 },
  chatBubbleOther:  { backgroundColor: "#1e1e1e", borderWidth: 0 },
  chatBubbleText:   { color: "#e8e8e8", fontSize: 15, lineHeight: 24, flexShrink: 1 },
  chatInputWrap:    { flexDirection: "row", gap: 8, padding: 10, borderBottomWidth: 0.5, borderBottomColor: "#1e1e1e", backgroundColor: "#000" },
  chatInputMulti:   { backgroundColor: "#111", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: "#fff", fontSize: 14, borderWidth: 1, borderColor: "#2a2a2a", maxHeight: 120, minHeight: 44 },
  chatInput:        { flex: 1, height: 40, backgroundColor: "#111", borderRadius: 20, paddingHorizontal: 14, color: "#fff", fontSize: 14, borderWidth: 1, borderColor: "#2a2a2a" },
  chatSendBtn:          { height: 40, paddingHorizontal: 16, backgroundColor: "#fff", borderRadius: 20, justifyContent: "center" },
  chatSendBtnDisabled:  { backgroundColor: "#1a1a1a" },
  chatSendBtnText:      { color: "#000", fontWeight: "700", fontSize: 13 },
  chatRandBtn:     { paddingHorizontal: 10, height: 40, borderRadius: 10, backgroundColor: "#0a1628", borderWidth: 1, borderColor: "#1a3a6a", alignItems: "center", justifyContent: "center" },
  chatRandBtnText: { fontSize: 11, color: "#7eb8ff", fontWeight: "600" },
  chatAbortBtn:     { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 10, borderWidth: 1, borderColor: "#5a1a1a", backgroundColor: "#1a0000" },
  chatAbortBtnText: { color: "#ff4444", fontSize: 12, fontWeight: "600" },
  chatResetBtn:     { paddingHorizontal: 12, paddingVertical: 4 },
  chatResetBtnText: { color: "#444", fontSize: 12 },
  chatHistoryBtn:      { paddingHorizontal: 10, paddingVertical: 4 },
  chatHistoryBtnText:  { color: "#3a6ea8", fontSize: 12 },
  chatHistoryPanel:    { backgroundColor: "#060e1a", borderBottomWidth: 0.5, borderBottomColor: "#0d1a2e" },
  chatHistoryHeader:   { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8 },
  chatHistoryTitle:    { color: "#3a6ea8", fontSize: 11, fontWeight: "700" },
  chatHistoryEmpty:    { color: "#333", fontSize: 12, padding: 12 },
  chatHistoryItem:     { paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 0.5, borderTopColor: "#0d1a2e" },
  chatHistoryItemTopic:{ color: "#7eb8ff", fontSize: 13, marginBottom: 2 },
  chatHistoryItemMeta: { color: "#2a4a6a", fontSize: 11 },
  chatTopicBadge: { alignSelf: "center", backgroundColor: "#111", borderRadius: 16, paddingHorizontal: 16, paddingVertical: 6, marginVertical: 8, borderWidth: 1, borderColor: "#2a2a2a" },
  chatTopicText:  { color: "#555", fontSize: 12, textAlign: "center", flexShrink: 1 },
  chatBottomWrap:   { borderTopWidth: 0.5, borderTopColor: "#1e1e1e", backgroundColor: "#000" },
  chatControlInner: { padding: 14 },
  chatTurnText:    { color: "#444", fontSize: 11, textAlign: "center", marginBottom: 10 },
  chatControlBtns: { flexDirection: "row", gap: 10 },
  chatStopBtn:      { flex: 1, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: "#333", alignItems: "center" },
  chatStopBtnText:  { color: "#555", fontSize: 14, fontWeight: "600" },
  chatContinueBtn:  { flex: 2, paddingVertical: 12, borderRadius: 12, backgroundColor: "#fff", alignItems: "center" },
  chatContinueBtnText: { color: "#000", fontSize: 14, fontWeight: "700" },
  chatInProgressBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#0a1020", paddingHorizontal: 14, paddingVertical: 6, borderTopWidth: 0.5, borderTopColor: "#1a3a6a" },
  chatInProgressText:{ color: "#3a6ea8", fontSize: 12 },
  chatInProgressLink:{ color: "#7eb8ff", fontSize: 12, fontWeight: "600" },
});
