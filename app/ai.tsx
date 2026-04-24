/**
 * ai.tsx — AIフィード画面
 *
 * - indexのエントリーとmyworldのリストをAsyncStorageから読む
 * - Claude APIがそれを見て質問・コメント・おすすめを生成
 * - フィード形式（カードが上から積まれる）
 * - 「もっと聞かせて」ボタンで追加生成
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

// ─── 型 ──────────────────────────────────────────────────
interface AICard {
  id:      string;
  type:    "question" | "comment" | "recommend";
  text:    string;
  loading: boolean;
}

interface ListItem {
  id: string; title: string; subtitle?: string; category: string;
}

interface Entry {
  id: string; text: string;
}

// ─── カードタイプのラベル・カラー ──────────────────────────
const TYPE_CONFIG = {
  question:  { label: "質問",       color: "#7eb8ff" },
  comment:   { label: "コメント",   color: "#a8e6a3" },
  recommend: { label: "おすすめ",   color: "#ffb347" },
};

// ─── Claude API 呼び出し ──────────────────────────────────
async function fetchAIMessage(
  entries: Entry[],
  myList: ListItem[],
  previousCards: AICard[],
  cardType: "question" | "comment" | "recommend"
): Promise<string> {
  const entriesText = entries.length > 0
    ? entries.map((e) => `- ${e.text}`).join("\n")
    : "（まだ何も入力されていません）";

  const myListText = myList.length > 0
    ? myList.map((m) => `- ${m.title}（${m.category}）`).join("\n")
    : "（まだ何も追加されていません）";

  const previousText = previousCards.length > 0
    ? previousCards.map((c) => `[${c.type}] ${c.text}`).join("\n")
    : "なし";

  const typeInstruction = {
    question:  "ユーザーの個性・趣味・価値観をもっと深く知るための、鋭くて興味深い質問を1つ生成してください。",
    comment:   "ユーザーの趣味や作品リストを見て、共感・発見・驚きを感じさせる短いコメントを1つ生成してください。",
    recommend: "ユーザーの趣味・好みに基づいて、具体的な作品・本・音楽などを1つおすすめしてください。理由も一言添えて。",
  }[cardType];

  const prompt = `あなたはユーザーの個性を深く理解しようとするAIアシスタントです。

【ユーザーが自分について書いたこと】
${entriesText}

【ユーザーのマイリスト（好きな作品など）】
${myListText}

【これまでに生成したメッセージ（重複を避けるため）】
${previousText}

指示: ${typeInstruction}

- 日本語で、自然な口語体で書いてください
- 1〜3文程度の短さにしてください
- 「あなたは〜ですね」のような決めつけは避けてください
- 前回と異なる角度・切り口にしてください
- 返答はメッセージ本文のみ。余計な前置きや説明は不要です`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":                    "application/json",
      "x-api-key":                       process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY ?? "",
      "anthropic-version":               "2023-06-01",
      "anthropic-dangerous-request-allowed": "true",
    },
    body: JSON.stringify({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 300,
      messages:   [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("Claude API error:", JSON.stringify(data));
    throw new Error(data.error?.message ?? "API error");
  }
  return data.content?.[0]?.text?.trim() ?? "メッセージを生成できませんでした。";
}

// ─── メインコンポーネント ──────────────────────────────────
export default function AIScreen() {
  const insets = useSafeAreaInsets();
  const [cards,    setCards]    = useState<AICard[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [entries,  setEntries]  = useState<Entry[]>([]);
  const [myList,   setMyList]   = useState<ListItem[]>([]);
  const [dataReady,setDataReady]= useState(false);
  const flatListRef = useRef<FlatList>(null);

  // ── データ読み込み ──
  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem("home_entries"),
      AsyncStorage.getItem("myworld_list"),
    ]).then(([entriesJson, listJson]) => {
      if (entriesJson) { try { setEntries(JSON.parse(entriesJson)); } catch {} }
      if (listJson)    { try { setMyList(JSON.parse(listJson));    } catch {} }
      setDataReady(true);
    });
  }, []);

  // ── 初回自動生成 ──
  useEffect(() => {
    if (dataReady && cards.length === 0) {
      generateCards(3);
    }
  }, [dataReady]);

  // ── カード生成 ──
  const generateCards = async (count = 2) => {
    if (loading) return;
    setLoading(true);

    const types: Array<"question" | "comment" | "recommend"> =
      count === 3
        ? ["question", "comment", "recommend"]
        : ["question", "recommend"];

    for (const type of types) {
      const placeholderId = `card_${Date.now()}_${type}`;
      setCards((prev) => [...prev, { id: placeholderId, type, text: "", loading: true }]);

      try {
        const text = await fetchAIMessage(entries, myList, cards, type);
        setCards((prev) =>
          prev.map((c) => c.id === placeholderId ? { ...c, text, loading: false } : c)
        );
      } catch {
        setCards((prev) =>
          prev.map((c) => c.id === placeholderId
            ? { ...c, text: "メッセージの生成に失敗しました。", loading: false }
            : c
          )
        );
      }

      // カード間に少しウェイト
      await new Promise((r) => setTimeout(r, 300));
    }

    setLoading(false);
  };

  const isEmpty = entries.length === 0 && myList.length === 0;

  return (
    <View style={[styles.container, { paddingTop: insets.top + 16 }]}>

      {/* ヘッダー */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>AI</Text>
        <Text style={styles.headerSub}>あなたについて考えています</Text>
      </View>

      {/* データがない場合 */}
      {isEmpty && !loading && (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>まだデータがありません</Text>
          <Text style={styles.emptyText}>
            ホーム画面に自分のことを入力するか{"\n"}
            マイワールドに作品を追加すると{"\n"}
            AIがあなたに語りかけます
          </Text>
        </View>
      )}

      {/* カードフィード */}
      <FlatList
        ref={flatListRef}
        data={cards}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.feedContent}
        onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
        renderItem={({ item }) => (
          <View style={[styles.card, { borderLeftColor: TYPE_CONFIG[item.type].color }]}>
            <View style={styles.cardHeader}>
              <Text style={[styles.cardType, { color: TYPE_CONFIG[item.type].color }]}>
                {TYPE_CONFIG[item.type].label}
              </Text>
            </View>
            {item.loading ? (
              <View style={styles.cardLoading}>
                <ActivityIndicator size="small" color="#555" />
                <Text style={styles.cardLoadingText}>考えています...</Text>
              </View>
            ) : (
              <Text style={styles.cardText}>{item.text}</Text>
            )}
          </View>
        )}
        ListEmptyComponent={
          loading ? (
            <View style={styles.initialLoading}>
              <ActivityIndicator color="#fff" />
              <Text style={styles.initialLoadingText}>あなたのことを考えています...</Text>
            </View>
          ) : null
        }
      />

      {/* もっと聞かせてボタン */}
      {!isEmpty && (
        <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
          <TouchableOpacity
            style={[styles.moreBtn, loading && styles.moreBtnDisabled]}
            onPress={() => generateCards(2)}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator size="small" color="#000" />
            ) : (
              <Text style={styles.moreBtnText}>もっと聞かせて</Text>
            )}
          </TouchableOpacity>
        </View>
      )}

    </View>
  );
}

// ─── スタイル ─────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },

  header: { paddingHorizontal: 20, paddingBottom: 16 },
  headerTitle: { color: "#fff", fontSize: 28, fontWeight: "700", letterSpacing: -0.5 },
  headerSub:   { color: "#444", fontSize: 13, marginTop: 2 },

  feedContent: { paddingHorizontal: 16, paddingBottom: 20 },

  card: {
    backgroundColor: "#0d0d0d",
    borderRadius:    16,
    padding:         18,
    marginBottom:    12,
    borderLeftWidth: 3,
    borderWidth:     1,
    borderColor:     "#1a1a1a",
  },
  cardHeader: { marginBottom: 8 },
  cardType:   { fontSize: 11, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" },
  cardText:   { color: "#e0e0e0", fontSize: 15, lineHeight: 24 },

  cardLoading:     { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  cardLoadingText: { color: "#555", fontSize: 13 },

  emptyState: { flex: 1, justifyContent: "center", alignItems: "center", padding: 40 },
  emptyTitle: { color: "#fff", fontSize: 18, fontWeight: "700", marginBottom: 12 },
  emptyText:  { color: "#444", fontSize: 14, textAlign: "center", lineHeight: 22 },

  initialLoading:     { paddingTop: 60, alignItems: "center", gap: 12 },
  initialLoadingText: { color: "#555", fontSize: 14 },

  footer:         { paddingHorizontal: 16, paddingTop: 8, borderTopWidth: 0.5, borderTopColor: "#1a1a1a" },
  moreBtn:        { backgroundColor: "#fff", borderRadius: 24, paddingVertical: 14, alignItems: "center" },
  moreBtnDisabled:{ backgroundColor: "#222" },
  moreBtnText:    { color: "#000", fontSize: 15, fontWeight: "700" },
});
