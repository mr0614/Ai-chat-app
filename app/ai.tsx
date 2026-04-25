/**
 * ai.tsx — AIフィード＋会話
 *
 * フィードカードの種類:
 *   comment  - 作品・自己紹介へのコメント
 *   question - 選択肢(A〜D) + 自由回答 の質問
 *
 * 選択 or 自由回答 → AIが短くリアクション → 回答履歴に蓄積
 * 会話中タブ: 返信したスレッド一覧
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SwipeListView } from "react-native-swipe-list-view";
import { useSafeAreaInsets } from "react-native-safe-area-context";

// ─── 型 ──────────────────────────────────────────────────
interface Choice { label: string; text: string; } // label="A" text="共感する"

interface FeedCard {
  id:        string;
  kind:      "comment" | "question";
  text:      string;           // コメント or 質問本文
  choices?:  Choice[];         // questionのみ: A〜D
  answered?: string;           // 選んだlabel or 自由回答テキスト
  reaction?: string;           // AI反応
  createdAt: number;
  loading:   boolean;
}

interface Message { role: "ai" | "user"; text: string; }

interface Thread {
  id:        string;
  seedText:  string;
  messages:  Message[];
  updatedAt: number;
}

interface ListItem { id: string; title: string; category: string; }
interface Entry    { id: string; text:  string; }

// ─── ストレージ ───────────────────────────────────────────
const FEED_KEY    = "ai_feed_cards_v2";
const THREADS_KEY = "ai_threads_v2";
const ANSWERS_KEY = "ai_answers";   // 回答履歴（キャラ分析用）

// ─── Claude API ───────────────────────────────────────────
const API_KEY = process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY ?? "";

async function callClaude(messages: { role: string; content: string }[], maxTokens = 400): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":                        "application/json",
      "x-api-key":                           API_KEY,
      "anthropic-version":                   "2023-06-01",
      "anthropic-dangerous-request-allowed": "true",
    },
    body: JSON.stringify({
      model:      "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      messages,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? "API error");
  return data.content?.[0]?.text?.trim() ?? "";
}

// ─── フィードカード生成 ───────────────────────────────────
async function generateCard(
  entries: Entry[],
  myList: ListItem[],
  existing: FeedCard[],
  answers: string[],
): Promise<Omit<FeedCard, "id" | "createdAt" | "loading">> {
  const entriesText = entries.map((e) => `- ${e.text}`).join("\n") || "（未入力）";
  const listText    = myList.map((m) => `- ${m.title}（${m.category}）`).join("\n") || "（未追加）";
  const recentText  = existing.filter((c) => !c.loading).slice(-6).map((c) => c.text).join("\n") || "なし";
  const answersText = answers.slice(-15).join("\n") || "なし";

  // 前回がquestionかcommentかを判定
  const lastKind = existing.filter((c) => !c.loading).slice(-1)[0]?.kind ?? "comment";

  const prompt = `あなたはユーザーの個性・価値観・思考パターンを深く洞察するAIです。

【ユーザーが自分について書いたこと】
${entriesText}

【マイリスト（好きな作品・音楽・本など）】
${listText}

【これまでの回答履歴（思考パターン分析用）】
${answersText}

【最近生成したカード（重複・類似禁止）】
${recentText}

---
まず内部分析を行ってください（出力には含めない）:
1. 自己紹介とマイリストの間に矛盾や興味深い組み合わせはあるか？
2. 回答履歴から見えるその人の傾向・価値観・思考パターンは？
3. まだ掘り下げていない角度・テーマは何か？
4. その人が気づいていない自分の特徴はあるか？

---
前回のカードが「${lastKind}」だったので、今回は${lastKind === "comment" ? "question" : "comment"}を優先してください。

--- パターン1: comment ---
以下のどれかのアプローチで：
・自己紹介×作品リストの意外な関連を指摘する
・回答パターンから見えるその人の特徴を、決めつけでなく「〜な気がする」で述べる
・その人が好きそうで知らなそうな作品・概念を提示する
自然な日本語2文以内。
JSONフォーマット: {"kind":"comment","text":"コメント本文"}

--- パターン2: question ---
以下のどれかのアプローチで：
・マイリストの特定作品のテーマと自己紹介を絡めた価値観の質問
・「この作品を好きな人がこれを好きなのは意外」という組み合わせへの質問
・前回の回答から派生した、より深いところを突く質問
・その人の日常の選択や判断に関わる議論的な問い

議論・意見が分かれるテーマには選択肢A〜D（2〜4個）を付ける。
純粋な感想・体験を聞く質問は選択肢なし（choicesを空配列か省略）。
選択肢は具体的な立場・意見（「わからない」「どちらでもない」系は禁止）。

JSONフォーマット:
{
  "kind": "question",
  "text": "質問本文",
  "choices": [
    {"label":"A","text":"選択肢A"},
    {"label":"B","text":"選択肢B"}
  ]
}

重要: JSONのみ返答。説明文・思考プロセス・マークダウン不要。`;

  const raw = await callClaude([{ role: "user", content: prompt }], 600);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("JSON parse failed");
  const parsed = JSON.parse(match[0]);

  return {
    kind:    parsed.kind === "question" ? "question" : "comment",
    text:    parsed.text ?? "",
    choices: parsed.choices?.length > 0 ? parsed.choices : undefined,
  };
}

// ─── 選択後のAI反応生成 ──────────────────────────────────
async function generateReaction(
  question: string,
  answer: string,
  entries: Entry[],
  myList: ListItem[],
  answers: string[],
): Promise<string> {
  const answersText = answers.slice(-8).join("\n") || "なし";
  const prompt = `ユーザーが次の質問に答えました。

質問: ${question}
回答: ${answer}

ユーザー自己紹介:
${entries.map((e) => `- ${e.text}`).join("\n") || "（未入力）"}

マイリスト:
${myList.map((m) => `- ${m.title}（${m.category}）`).join("\n") || "（未追加）"}

過去の回答パターン:
${answersText}

この回答への短いリアクションを1〜2文で。
・過去の回答と比較して「一貫している/意外」などの観察をしてもいい
・その回答から見えるその人らしさを「〜な人なのかも」と軽く触れてもいい
・次の深掘りポイントを示唆してもいい
決めつけず、その人の視点を面白がるトーンで。返答はリアクション本文のみ。`;

  return await callClaude([{ role: "user", content: prompt }], 250);
}

// ─── スレッド返信 ─────────────────────────────────────────
async function replyInThread(thread: Thread, userMessage: string, entries: Entry[], myList: ListItem[]): Promise<string> {
  const ctx = `あなたはユーザーの個性を深く理解しようとするAIです。
ユーザー: ${entries.map((e) => e.text).join(" / ") || "（未入力）"}
好きな作品: ${myList.map((m) => m.title).join(", ") || "（未追加）"}
自然な日本語で2〜3文以内。`;

  const messages = [
    { role: "user",      content: ctx },
    { role: "assistant", content: "わかりました。" },
    ...thread.messages.map((m) => ({ role: m.role === "ai" ? "assistant" : "user", content: m.text })),
    { role: "user", content: userMessage },
  ];
  return await callClaude(messages, 250);
}

// ─── スレッドモーダル ─────────────────────────────────────
function ThreadModal({ thread, onClose, onUpdate, entries, myList }: {
  thread: Thread; onClose: () => void;
  onUpdate: (t: Thread) => void; entries: Entry[]; myList: ListItem[];
}) {
  const insets    = useSafeAreaInsets();
  const [input,   setInput]   = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput(""); Keyboard.dismiss();
    const userMsg: Message = { role: "user", text };
    const updated = { ...thread, messages: [...thread.messages, userMsg], updatedAt: Date.now() };
    onUpdate(updated); setLoading(true);
    try {
      const aiText = await replyInThread(updated, text, entries, myList);
      onUpdate({ ...updated, messages: [...updated.messages, { role: "ai", text: aiText }], updatedAt: Date.now() });
    } catch {
      onUpdate({ ...updated, messages: [...updated.messages, { role: "ai", text: "返答できませんでした。" }], updatedAt: Date.now() });
    } finally { setLoading(false); }
  };

  return (
    <Modal visible animationType="slide" transparent>
      <KeyboardAvoidingView style={styles.modalBg} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <View style={[styles.modalHeader, { paddingTop: insets.top + 12 }]}>
          <TouchableOpacity onPress={onClose} style={styles.modalCloseBtn}>
            <Text style={styles.modalCloseTxt}>✕ 閉じる</Text>
          </TouchableOpacity>
        </View>
        <ScrollView ref={scrollRef} style={styles.threadScroll} contentContainerStyle={styles.threadContent}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}>
          {thread.messages.map((msg, i) => (
            <View key={i} style={[styles.bubble, msg.role === "user" ? styles.bubbleUser : styles.bubbleAI]}>
              <Text style={[styles.bubbleText, msg.role === "user" ? styles.bubbleTextUser : styles.bubbleTextAI]}>
                {msg.text}
              </Text>
            </View>
          ))}
          {loading && <View style={styles.bubbleAI}><ActivityIndicator size="small" color="#888" /></View>}
        </ScrollView>
        <View style={[styles.threadInputRow, { paddingBottom: insets.bottom + 8 }]}>
          <TextInput style={styles.threadInput} placeholder="返信する..." placeholderTextColor="#555"
            value={input} onChangeText={setInput} returnKeyType="send"
            onSubmitEditing={handleSend} blurOnSubmit={false} />
          <TouchableOpacity style={[styles.sendBtn, (!input.trim() || loading) && styles.sendBtnDisabled]}
            onPress={handleSend} disabled={!input.trim() || loading}>
            <Text style={styles.sendBtnText}>送信</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─── フィードカードコンポーネント ────────────────────────
function FeedCardView({ card, onAnswer, onTapForThread }: {
  card: FeedCard;
  onAnswer: (cardId: string, answer: string) => void;
  onTapForThread: (card: FeedCard) => void;
}) {
  const [freeText, setFreeText] = useState("");
  const [showInput, setShowInput] = useState(false);

  const answered = !!card.answered;

  const handleChoice = (choice: Choice) => {
    if (answered) return;
    onAnswer(card.id, `${choice.label}: ${choice.text}`);
  };

  const handleFreeSubmit = () => {
    const text = freeText.trim();
    if (!text) return;
    onAnswer(card.id, text);
    setFreeText(""); setShowInput(false); Keyboard.dismiss();
  };

  return (
    <View style={styles.feedCard}>
      {/* 質問/コメント本文 */}
      <Text style={styles.feedCardText}>{card.loading && !card.text ? "考えています..." : card.text}</Text>

      {card.loading && !card.text && <ActivityIndicator size="small" color="#555" style={{ marginTop: 8 }} />}

      {/* 選択肢（questionのみ・未回答） */}
      {!card.loading && card.kind === "question" && !answered && (
        <View style={styles.choicesWrap}>
          {(card.choices ?? []).map((c) => (
            <TouchableOpacity key={c.label} style={styles.choiceBtn} onPress={() => handleChoice(c)}>
              <Text style={styles.choiceLabel}>{c.label}</Text>
              <Text style={styles.choiceText}>{c.text}</Text>
            </TouchableOpacity>
          ))}
          {/* 自由回答 */}
          {showInput ? (
            <View style={styles.freeInputRow}>
              <TextInput style={styles.freeInput} placeholder="自由に回答..." placeholderTextColor="#555"
                value={freeText} onChangeText={setFreeText} returnKeyType="done" onSubmitEditing={handleFreeSubmit} />
              <TouchableOpacity style={styles.freeSubmitBtn} onPress={handleFreeSubmit} disabled={!freeText.trim()}>
                <Text style={styles.freeSubmitTxt}>送信</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity style={styles.freeBtn} onPress={() => setShowInput(true)}>
              <Text style={styles.freeBtnTxt}>自由に回答する...</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* 回答済み表示 */}
      {answered && (
        <View style={styles.answeredWrap}>
          <Text style={styles.answeredLabel}>あなたの回答</Text>
          <Text style={styles.answeredText}>{card.answered}</Text>
          {card.reaction ? (
            <Text style={styles.reactionText}>{card.reaction}</Text>
          ) : (
            <ActivityIndicator size="small" color="#555" style={{ marginTop: 6 }} />
          )}
        </View>
      )}

      {/* コメントカード or 回答済みカードのタップ → スレッドへ */}
      {!card.loading && (card.kind === "comment" || answered) && (
        <TouchableOpacity style={styles.feedCardHintBtn} onPress={() => onTapForThread(card)}>
          <Text style={styles.feedCardHint}>💬 会話を続ける</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ─── メイン ───────────────────────────────────────────────
export default function AIScreen() {
  const insets = useSafeAreaInsets();

  const [activeTab,  setActiveTab]  = useState<"feed" | "threads">("feed");
  const [feedCards,  setFeedCards]  = useState<FeedCard[]>([]);
  const [threads,    setThreads]    = useState<Thread[]>([]);
  const [entries,    setEntries]    = useState<Entry[]>([]);
  const [myList,     setMyList]     = useState<ListItem[]>([]);
  const [answers,    setAnswers]    = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [openThread, setOpenThread] = useState<Thread | null>(null);

  // ── データ読み込み ──
  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem("home_entries"),
      AsyncStorage.getItem("myworld_list"),
      AsyncStorage.getItem(FEED_KEY),
      AsyncStorage.getItem(THREADS_KEY),
      AsyncStorage.getItem(ANSWERS_KEY),
    ]).then(([e, m, f, t, a]) => {
      if (e) try { setEntries(JSON.parse(e));   } catch {}
      if (m) try { setMyList(JSON.parse(m));     } catch {}
      if (f) try { setFeedCards(JSON.parse(f));  } catch {}
      if (t) try { setThreads(JSON.parse(t));    } catch {}
      if (a) try { setAnswers(JSON.parse(a));    } catch {}
    });
  }, []);

  // ── 永続化 ──
  useEffect(() => {
    const completed = feedCards.filter((c) => !c.loading);
    if (completed.length > 0) AsyncStorage.setItem(FEED_KEY, JSON.stringify(completed));
  }, [feedCards]);

  useEffect(() => { AsyncStorage.setItem(THREADS_KEY, JSON.stringify(threads)); }, [threads]);
  useEffect(() => { AsyncStorage.setItem(ANSWERS_KEY, JSON.stringify(answers)); }, [answers]);

  // ── 初回生成 ──
  useEffect(() => {
    const completed = feedCards.filter((c) => !c.loading);
    const latest    = completed.slice(-1)[0];
    const age       = latest ? Date.now() - latest.createdAt : Infinity;
    if (age > 10 * 60 * 1000 || completed.length < 3) addCard();
  }, [entries, myList]);

  // ── カード追加 ──
  const addCard = useCallback(async () => {
    if (generating) return;
    setGenerating(true);
    const pid = `card_${Date.now()}`;
    setFeedCards((prev) => [...prev, { id: pid, kind: "comment", text: "", createdAt: Date.now(), loading: true }]);
    try {
      const result = await generateCard(entries, myList, feedCards, answers);
      setFeedCards((prev) =>
        prev.map((c) => c.id === pid ? { ...c, ...result, loading: false } : c)
      );
    } catch {
      setFeedCards((prev) => prev.filter((c) => c.id !== pid));
    } finally { setGenerating(false); }
  }, [generating, entries, myList, feedCards, answers]);

  // ── 回答処理 ──
  const handleAnswer = useCallback(async (cardId: string, answer: string) => {
    // 即座に回答を表示
    setFeedCards((prev) =>
      prev.map((c) => c.id === cardId ? { ...c, answered: answer } : c)
    );
    // 回答履歴に追加
    const card = feedCards.find((c) => c.id === cardId);
    const answerRecord = `Q: ${card?.text ?? ""} → A: ${answer}`;
    setAnswers((prev) => [...prev, answerRecord]);

    // AI反応を生成
    try {
      const reaction = await generateReaction(card?.text ?? "", answer, entries, myList, answers);
      setFeedCards((prev) =>
        prev.map((c) => c.id === cardId ? { ...c, reaction } : c)
      );
    } catch {}
  }, [feedCards, entries, myList]);

  // ── スレッド開始 ──
  const handleTapForThread = (card: FeedCard) => {
    const existing = threads.find((t) => t.id === card.id);
    if (existing) { setOpenThread(existing); return; }
    const seed = card.answered
      ? `${card.text}\n私の回答: ${card.answered}`
      : card.text;
    const initMessages: Message[] = [
      { role: "ai", text: card.text },
      ...(card.answered ? [{ role: "user" as const, text: card.answered }] : []),
      ...(card.reaction  ? [{ role: "ai"   as const, text: card.reaction  }] : []),
    ];
    const newThread: Thread = { id: card.id, seedText: seed, messages: initMessages, updatedAt: Date.now() };
    setThreads((prev) => [newThread, ...prev]);
    setOpenThread(newThread);
  };

  // ── スレッド更新 ──
  const handleThreadUpdate = (updated: Thread) => {
    setThreads((prev) => prev.map((t) => t.id === updated.id ? updated : t));
    setOpenThread(updated);
  };

  const completed = feedCards.filter((c) => !c.loading || c.text);

  return (
    <View style={[styles.container, { paddingTop: insets.top + 12 }]}>
      <Text style={styles.headerTitle}>AI</Text>

      {/* タブ */}
      <View style={styles.tabRow}>
        {(["feed", "threads"] as const).map((tab) => (
          <TouchableOpacity key={tab}
            style={[styles.tabBtn, activeTab === tab && styles.tabBtnActive]}
            onPress={() => setActiveTab(tab)}>
            <Text style={[styles.tabTxt, activeTab === tab && styles.tabTxtActive]}>
              {tab === "feed" ? "フィード" : `会話中${threads.length > 0 ? ` (${threads.length})` : ""}`}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* フィード */}
      {activeTab === "feed" && (
        <>
          <FlatList
            data={[...completed].reverse()}
            keyExtractor={(item) => item.id}
            contentContainerStyle={[styles.listContent, { paddingBottom: 100 }]}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <FeedCardView
                card={item}
                onAnswer={handleAnswer}
                onTapForThread={handleTapForThread}
              />
            )}
            ListEmptyComponent={
              generating ? (
                <View style={styles.emptyState}>
                  <ActivityIndicator color="#fff" />
                  <Text style={styles.emptyText}>考えています...</Text>
                </View>
              ) : null
            }
          />
          <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
            <TouchableOpacity
              style={[styles.moreBtn, generating && styles.moreBtnDisabled]}
              onPress={addCard} disabled={generating}>
              {generating
                ? <ActivityIndicator size="small" color="#555" />
                : <Text style={styles.moreBtnText}>もっと見る</Text>
              }
            </TouchableOpacity>
          </View>
        </>
      )}

      {/* 会話中 */}
      {activeTab === "threads" && (
        <SwipeListView
          data={[...threads].sort((a, b) => b.updatedAt - a.updatedAt)}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => {
            const last = item.messages[item.messages.length - 1];
            return (
              <TouchableOpacity style={styles.threadCard} onPress={() => setOpenThread(item)} activeOpacity={0.7}>
                <Text style={styles.threadSeed} numberOfLines={1}>{item.seedText}</Text>
                <Text style={styles.threadLast} numberOfLines={2}>
                  {last.role === "ai" ? "AI: " : "あなた: "}{last.text}
                </Text>
                <Text style={styles.threadCount}>{item.messages.length}件</Text>
              </TouchableOpacity>
            );
          }}
          renderHiddenItem={({ item }) => (
            <TouchableOpacity
              style={styles.threadDeleteBtn}
              onPress={() => setThreads((prev) => prev.filter((t) => t.id !== item.id))}
            >
              <Text style={styles.threadDeleteTxt}>削除</Text>
            </TouchableOpacity>
          )}
          rightOpenValue={-80}
          disableRightSwipe
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>フィードのカードをタップして会話を始めましょう</Text>
            </View>
          }
        />
      )}

      {openThread && (
        <ThreadModal thread={openThread} onClose={() => setOpenThread(null)}
          onUpdate={handleThreadUpdate} entries={entries} myList={myList} />
      )}
    </View>
  );
}

// ─── スタイル ─────────────────────────────────────────────
const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: "#000" },
  headerTitle: { color: "#fff", fontSize: 26, fontWeight: "700", paddingHorizontal: 20, marginBottom: 12 },

  tabRow:       { flexDirection: "row", paddingHorizontal: 16, gap: 8, marginBottom: 12 },
  tabBtn:       { paddingHorizontal: 18, paddingVertical: 8, borderRadius: 20, backgroundColor: "#1a1a1a", borderWidth: 1, borderColor: "#2a2a2a" },
  tabBtnActive: { backgroundColor: "#fff", borderColor: "#fff" },
  tabTxt:       { color: "#666", fontSize: 13, fontWeight: "600" },
  tabTxtActive: { color: "#000" },

  listContent: { paddingHorizontal: 16, paddingBottom: 20 },

  feedCard: {
    backgroundColor: "#0d0d0d", borderRadius: 16, padding: 16,
    marginBottom: 12, borderWidth: 1, borderColor: "#1e1e1e",
  },
  feedCardText: { color: "#e0e0e0", fontSize: 15, lineHeight: 24 },

  // 選択肢
  choicesWrap: { marginTop: 14, gap: 8 },
  choiceBtn:   { flexDirection: "row", alignItems: "flex-start", backgroundColor: "#1a1a1a", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#2a2a2a", gap: 10 },
  choiceLabel: { color: "#fff", fontWeight: "700", fontSize: 14, minWidth: 20 },
  choiceText:  { color: "#ccc", fontSize: 14, lineHeight: 20, flex: 1 },

  // 自由回答
  freeBtn:      { paddingVertical: 10, alignItems: "center", borderWidth: 1, borderColor: "#2a2a2a", borderRadius: 12, marginTop: 4 },
  freeBtnTxt:   { color: "#555", fontSize: 13 },
  freeInputRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  freeInput:    { flex: 1, height: 40, backgroundColor: "#1a1a1a", borderRadius: 20, paddingHorizontal: 14, color: "#fff", fontSize: 14, borderWidth: 1, borderColor: "#333" },
  freeSubmitBtn:{ height: 40, paddingHorizontal: 14, backgroundColor: "#fff", borderRadius: 20, justifyContent: "center" },
  freeSubmitTxt:{ color: "#000", fontWeight: "700", fontSize: 13 },

  // 回答済み
  answeredWrap:  { marginTop: 12, backgroundColor: "#111", borderRadius: 10, padding: 12, borderLeftWidth: 2, borderLeftColor: "#444" },
  answeredLabel: { color: "#555", fontSize: 11, marginBottom: 4 },
  answeredText:  { color: "#fff", fontSize: 14, marginBottom: 8 },
  reactionText:  { color: "#aaa", fontSize: 13, lineHeight: 20, fontStyle: "italic" },

  feedCardHintBtn: { marginTop: 10 },
  feedCardHint:    { color: "#444", fontSize: 12 },

  // スレッドリスト
  threadDeleteBtn: { alignItems: "flex-end", justifyContent: "center", flex: 1, backgroundColor: "#ff3b30", paddingRight: 24, marginBottom: 10, borderRadius: 14 },
  threadDeleteTxt: { color: "#fff", fontWeight: "700", fontSize: 14 },
  threadSeed:  { color: "#fff", fontSize: 14, fontWeight: "600" },
  threadLast:  { color: "#888", fontSize: 13, lineHeight: 20 },
  threadCount: { color: "#444", fontSize: 11, marginTop: 2 },

  emptyState: { paddingTop: 60, alignItems: "center", gap: 12 },
  emptyText:  { color: "#444", fontSize: 14, textAlign: "center", lineHeight: 22, paddingHorizontal: 32 },

  footer:          { position: "absolute", bottom: 0, left: 0, right: 0, paddingHorizontal: 16, paddingTop: 8, backgroundColor: "#000", borderTopWidth: 0.5, borderTopColor: "#1a1a1a" },
  moreBtn:         { backgroundColor: "#fff", borderRadius: 24, paddingVertical: 13, alignItems: "center" },
  moreBtnDisabled: { backgroundColor: "#1a1a1a" },
  moreBtnText:     { color: "#000", fontSize: 14, fontWeight: "700" },

  // モーダル
  modalBg:       { flex: 1, backgroundColor: "#000" },
  modalHeader:   { paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 0.5, borderBottomColor: "#1a1a1a" },
  modalCloseBtn: { alignSelf: "flex-start", paddingHorizontal: 14, paddingVertical: 8, backgroundColor: "#1a1a1a", borderRadius: 20 },
  modalCloseTxt: { color: "#fff", fontSize: 14 },
  threadScroll:  { flex: 1 },
  threadContent: { padding: 16, gap: 10 },
  bubble:         { maxWidth: "80%", borderRadius: 16, padding: 12 },
  bubbleAI:       { alignSelf: "flex-start", backgroundColor: "#1a1a1a" },
  bubbleUser:     { alignSelf: "flex-end",   backgroundColor: "#fff" },
  bubbleText:     { fontSize: 15, lineHeight: 22 },
  bubbleTextAI:   { color: "#e0e0e0" },
  bubbleTextUser: { color: "#000" },
  threadInputRow: { flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingTop: 10, borderTopWidth: 0.5, borderTopColor: "#1a1a1a", backgroundColor: "#000" },
  threadInput:    { flex: 1, height: 44, backgroundColor: "#1a1a1a", borderRadius: 22, paddingHorizontal: 16, color: "#fff", fontSize: 14, borderWidth: 1, borderColor: "#333" },
  sendBtn:        { height: 44, paddingHorizontal: 18, backgroundColor: "#fff", borderRadius: 22, justifyContent: "center" },
  sendBtnDisabled:{ backgroundColor: "#222" },
  sendBtnText:    { color: "#000", fontWeight: "700", fontSize: 14 },
});
