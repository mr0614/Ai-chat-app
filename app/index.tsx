import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  PanResponder,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SwipeListView } from "react-native-swipe-list-view";
import { useSafeAreaInsets } from "react-native-safe-area-context";

interface Entry { id: string; text: string; createdAt: number; aiSuggested?: boolean; }
interface ListItem { id: string; title: string; category: string; }
interface AnalysisRecord { id: string; text: string; summary: string; createdAt: number; }

const STORAGE_KEY = "home_entries";
const SUGG_KEY    = "index_suggestions";
const API_KEY     = process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY ?? "";
const INTERVAL_MS = 3 * 60 * 1000;

async function callClaude(prompt: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-request-allowed": "true",
    },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await res.json();
  return data.content?.[0]?.text?.trim() ?? "";
}

// count件だけ生成して返す
async function fetchNewSuggestions(excludeTexts: string[], count = 3): Promise<string[]> {
  const [listJ, anJ] = await Promise.all([
    AsyncStorage.getItem("myworld_list"),
    AsyncStorage.getItem("ai_analysis_v7"),
  ]);
  const myList   = listJ ? (JSON.parse(listJ) as ListItem[])       : [];
  const analyses = anJ   ? (JSON.parse(anJ)   as AnalysisRecord[]) : [];
  const nonMusic = myList.filter((m) => m.category !== "music").slice(0, 20).map((m) => `${m.title}（${m.category}）`).join(", ") || "なし";
  const music    = myList.filter((m) => m.category === "music").slice(0, 8).map((m) => m.title).join(", ");
  const analysis = analyses[0]?.text?.slice(0, 500) || "";
  const summary  = analyses[0]?.summary || "";

  const prompt = `ユーザーの自己紹介文候補を必ず${count}件生成してください。

【除外（既存・表示中・追加済み）】
${excludeTexts.length ? excludeTexts.join("\n") : "なし"}
【マイリスト】${nonMusic}
${music ? `【音楽の好み】${music}` : ""}
${summary ? `【AIキャッチコピー】${summary}` : ""}
${analysis ? `【AI分析】${analysis}` : ""}

━━━ 厳格な生成ルール ━━━

step1: マイリストの具体的な作品名・アーティスト名から「この人が繰り返し選んでいるもの」を箇条書きで分析する（内部処理のみ）
step2: その選択パターンから「普段の行動・習慣・思考の癖」を推測する
step3: それを一人称の短文で書く

【出力例（このレベルの具体性が必要）】
・「泣いた後に同じ曲をリピートしてしまう」
・「結末を知ってから最初から見返す癖がある」
・「好きになると関連作品を全部さかのぼってしまう」
・「BGMより無音で集中するタイプだと気づいた」
・「キャラクターより世界の仕組みの方が気になる」
・「面白いと思ったら誰かに話したくて仕方なくなる」
・「一人で没頭する時間がないとストレスが溜まる」
・「主人公に感情移入できないと途中でやめてしまう」

【絶対禁止】
・「〜が好き」「〜を大切にしている」「〜な価値観を持つ」などの抽象表現
・作品名・アーティスト名を文中に入れる
・「感情豊か」「共感力が高い」などの性格形容詞
・除外リストと意味が重複する文

1件18〜38字、口語、一人称（「〜してしまう」「〜な気がする」「〜しがち」）
必ず${count}件出力

JSONのみ: {"s":["...","...","..."]}`;

  try {
    const raw = await callClaude(prompt);
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return [];
    return (JSON.parse(m[0]).s ?? []).slice(0, count) as string[];
  } catch { return []; }
}

function SpinIcon({ spinning }: { spinning: boolean }) {
  const rot = React.useRef(new Animated.Value(0)).current;
  React.useEffect(() => {
    if (spinning) {
      Animated.loop(Animated.timing(rot, { toValue: 1, duration: 800, useNativeDriver: true })).start();
    } else {
      rot.setValue(0);
    }
  }, [spinning]);
  const rotate = rot.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.Text style={[{ fontSize: 12, color: "#4a8fd4" }, spinning && { transform: [{ rotate }] }]}>
      ↻
    </Animated.Text>
  );
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const [entries,     setEntries]     = useState<Entry[]>([]);
  const [inputText,   setInputText]   = useState("");
  const [suggestions,   setSuggestions]   = useState<string[]>([]);
  const [aiSummary,     setAiSummary]     = useState<{ summary: string; style: string } | null>(null);
  const [aiSummaryLoading, setAiSummaryLoading] = useState(false);
  const [refreshing,  setRefreshing]  = useState(false);
  const inputRef      = useRef<TextInput>(null);
  const timerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generatingRef = useRef(false);
  const suggestionsRef = useRef<string[]>([]);
  const entriesRef     = useRef<Entry[]>([]);
  suggestionsRef.current = suggestions;
  entriesRef.current     = entries;

  // スワイプ検出用
  const swipeX    = useRef(new Animated.Value(0)).current;
  const swipeStart = useRef(0);
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 12 && Math.abs(g.dy) < 20,
      onPanResponderGrant: (_, g) => { swipeStart.current = g.x0; },
      onPanResponderMove: Animated.event([null, { dx: swipeX }], { useNativeDriver: false }),
      onPanResponderRelease: (_, g) => {
        Animated.spring(swipeX, { toValue: 0, useNativeDriver: false }).start();
        // 左スワイプ（-60px以上）で全件再生成
        if (g.dx < -60) regenerateAll();
      },
    })
  ).current;

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((j) => { if (j) try { setEntries(JSON.parse(j)); } catch {} });
    AsyncStorage.getItem(SUGG_KEY).then((j)    => { if (j) try { setSuggestions(JSON.parse(j)); } catch {} });
    // MyWorld・entries のハッシュを保存して変更時のみ再生成
    Promise.all([
      AsyncStorage.getItem("home_entries"),
      AsyncStorage.getItem("myworld_list"),
      AsyncStorage.getItem("ai_summary_hash"),
    ]).then(([entJ, listJ, hashJ]) => {
      const newHash = (entJ?.length ?? 0) + "_" + (listJ?.length ?? 0);
      if (newHash !== hashJ) {
        setTimeout(generateAiSummary, 1000);
        AsyncStorage.setItem("ai_summary_hash", newHash);
      }
    });
  }, []);

  const generateAiSummary = async () => {
    setAiSummaryLoading(true);
    try {
      const [entJ, listJ, anJ, ansJ] = await Promise.all([
        AsyncStorage.getItem("home_entries"),
        AsyncStorage.getItem("myworld_list"),
        AsyncStorage.getItem("ai_analysis_v7"),
        AsyncStorage.getItem("ai_answers_v7"),
      ]);
      const ents: Entry[]      = entJ  ? JSON.parse(entJ)  : [];
      const myList: ListItem[] = listJ ? JSON.parse(listJ) : [];
      const analyses: AnalysisRecord[] = anJ ? JSON.parse(anJ) : [];
      const answers: string[]  = ansJ  ? JSON.parse(ansJ)  : [];
      if (!ents.length && !myList.length) return;
      const entText  = ents.filter((e) => !e.aiSuggested).slice(0, 5).map((e) => e.text).join("、") || "なし";
      const listText = myList.filter((m) => m.category !== "music").slice(0, 8).map((m) => m.title).join("、") || "なし";
      const music    = myList.filter((m) => m.category === "music").slice(0, 4).map((m) => m.title).join("、");
      const ansText  = answers.slice(-5).join(" / ") || "なし";
      const summary  = analyses[0]?.summary || "";
      const prompt = "以下のユーザー情報をもとに、このユーザーが普段どんな話し方をするか推測し2点を返してください。" +
        "1)キャッチコピー（20字以内）2)話し方の特徴（口調・テンション・使いそうな言葉、30字以内）" +
        " 自己紹介:" + entText + " 好きな作品:" + listText + (music ? " 音楽:" + music : "") +
        " フィード回答:" + ansText + (summary ? " キャッチコピー:" + summary : "") +
        ' JSONのみ:{"summary":"...","style":"..."}';
      const raw = await callClaude(prompt);
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        const p = JSON.parse(m[0]);
        const result = { summary: p.summary ?? "", style: p.style ?? "" };
        setAiSummary(result);
        await AsyncStorage.setItem("ai_summary_cache", JSON.stringify(result));
      }
    } catch {}
    setAiSummaryLoading(false);
  };

  useEffect(() => { AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); }, [entries]);

  const scheduleNext = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => regenerateAll(), INTERVAL_MS);
  };

  // 3件まとめて再生成
  const regenerateAll = async () => {
    if (generatingRef.current) return;
    generatingRef.current = true;
    setRefreshing(true);
    try {
      const done = entriesRef.current.filter((e) => !e.aiSuggested).map((e) => e.text);
      const suggs = await fetchNewSuggestions(done, 3);
      if (suggs.length > 0) {
        setSuggestions(suggs);
        await AsyncStorage.setItem(SUGG_KEY, JSON.stringify(suggs));
      }
    } catch {}
    generatingRef.current = false;
    setRefreshing(false);
    // タイマーは起動しない（手動のみ）
  };

  // 1件選択 → その1件を除いた2件を残し、1件だけ新たに生成して末尾に追加
  const pickSuggestion = async (s: string) => {
    // エントリに追加
    setEntries((prev) => [{ id: Date.now().toString(), text: s, createdAt: Date.now() }, ...prev]);
    // 残り2件
    const remaining = suggestionsRef.current.filter((x) => x !== s);
    setSuggestions(remaining);
    AsyncStorage.setItem(SUGG_KEY, JSON.stringify(remaining));

    // 1件だけ補充
    if (generatingRef.current) return;
    generatingRef.current = true;
    try {
      const done    = [...entriesRef.current.filter((e) => !e.aiSuggested).map((e) => e.text), s];
      const exclude = [...done, ...remaining];
      const newOne  = await fetchNewSuggestions(exclude, 1);
      if (newOne.length > 0) {
        const next = [...remaining, ...newOne];
        setSuggestions(next);
        await AsyncStorage.setItem(SUGG_KEY, JSON.stringify(next));
      }
    } catch {}
    generatingRef.current = false;
  };

  // 起動時
  useEffect(() => {
    // キャッシュがあれば表示だけする（自動生成はしない）
    AsyncStorage.getItem(SUGG_KEY).then((j) => {
      if (j) try { setSuggestions(JSON.parse(j)); } catch {}
    });
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  const handleSubmit = (text?: string) => {
    const t = (text ?? inputText).trim();
    if (!t) return;
    setEntries((prev) => [{ id: Date.now().toString(), text: t, createdAt: Date.now() }, ...prev]);
    setInputText("");
    Keyboard.dismiss();
  };

  const deleteEntry = (id: string) => setEntries((prev) => prev.filter((e) => e.id !== id));

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : "height"}>

      {entries.length > 0 ? (
        <SwipeListView
          data={entries}
          keyExtractor={(item) => item.id}
          style={styles.list}
          contentContainerStyle={[styles.listContent, { paddingTop: insets.top + 12 }]}
          onScrollBeginDrag={() => Keyboard.dismiss()}
          renderItem={({ item, index }) => (
            <View style={[
              styles.entryCard,
              index === 0 && styles.entryCardFirst,
              item.aiSuggested && styles.entryCardAI,
            ]}>
              {item.aiSuggested && <Text style={styles.entryAILabel}>AIからの提案</Text>}
              <Text style={[styles.entryText, item.aiSuggested && styles.entryTextAI]}>{item.text}</Text>
            </View>
          )}
          renderHiddenItem={({ item }) => (
            <TouchableOpacity style={styles.deleteBtn} onPress={() => deleteEntry(item.id)}>
              <Text style={styles.deleteBtnText}>削除</Text>
            </TouchableOpacity>
          )}
          rightOpenValue={-72}
          disableRightSwipe
        />
      ) : (
        <View style={[styles.emptyState, { paddingTop: insets.top + 60 }]}>
          <Text style={styles.emptyText}>あなた自身について{"\n"}教えてください</Text>
        </View>
      )}

      {/* 候補エリア（ボタン押下後のみ表示） */}
      {suggestions.length > 0 && (
        <Animated.View
          style={[styles.suggSection, { transform: [{ translateX: swipeX }] }]}
          {...panResponder.panHandlers}
        >
          <View style={styles.suggHeader}>
            <Text style={styles.suggLabel}>あなたはこんな人では？</Text>
            <TouchableOpacity style={styles.refreshBtn} onPress={regenerateAll} disabled={refreshing}>
              <SpinIcon spinning={refreshing} />
              <Text style={[styles.suggRefresh, refreshing && { color: "#4a8fd4" }]}>
                {refreshing ? " 更新中..." : " 左スワイプで更新"}
              </Text>
            </TouchableOpacity>
          </View>
          {suggestions.map((s, i) => (
            <TouchableOpacity key={i} style={styles.suggRow} onPress={() => pickSuggestion(s)} activeOpacity={0.7}>
              <Text style={styles.suggText}>{s}</Text>
              <Text style={styles.suggArrow}>＋</Text>
            </TouchableOpacity>
          ))}
        </Animated.View>
      )}

      {/* あなたAIカード（入力バーの上・常時表示） */}
      <View style={styles.inputWrapper}>
        {aiSummary && (
          <View style={styles.aiCard}>
            <View style={styles.aiCardHeader}>
              <Text style={styles.aiCardLabel}>あなたAI</Text>
              <View style={{ flexDirection: "row", gap: 12 }}>
                <TouchableOpacity onPress={() => { setSuggestions([]); AsyncStorage.removeItem(SUGG_KEY); regenerateAll(); }}>
                  <Text style={styles.aiCardRefreshText}>提案を見る</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={generateAiSummary}>
                  <Text style={styles.aiCardRefreshText}>更新</Text>
                </TouchableOpacity>
              </View>
            </View>
            <Text style={styles.aiCardSummary}>{aiSummary.summary}</Text>
            <Text style={styles.aiCardStyle}>{aiSummary.style}</Text>
          </View>
        )}
        {aiSummaryLoading && !aiSummary && (
          <View style={styles.aiCard}>
            <Text style={styles.aiCardLoading}>あなたAIを分析中...</Text>
          </View>
        )}
        {!aiSummary && !aiSummaryLoading && (
          <TouchableOpacity style={styles.aiCardEmpty} onPress={generateAiSummary}>
            <Text style={styles.aiCardEmptyText}>あなたAIを分析する</Text>
          </TouchableOpacity>
        )}

        {/* 入力バー */}
        <View style={[styles.inputRow, { paddingBottom: insets.bottom + 8 }]}>
          <TextInput
            ref={inputRef}
            style={styles.input}
            placeholder="あなたについて教えて"
            placeholderTextColor="#555"
            value={inputText}
            onChangeText={setInputText}
            returnKeyType="done"
            onSubmitEditing={() => handleSubmit()}
            blurOnSubmit={false}
            autoCorrect={false}
          />
          {suggestions.length === 0 && (
            <TouchableOpacity style={styles.suggTriggerBtn} onPress={regenerateAll} disabled={refreshing}>
              <Text style={styles.suggTriggerText}>{refreshing ? "..." : "提案"}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: "#000" },
  list:        { flex: 1 },
  listContent: { paddingHorizontal: 14, paddingBottom: 8 },

  entryCard:      { borderWidth: 1, borderColor: "#1e1e1e", borderRadius: 10, paddingVertical: 9, paddingHorizontal: 13, marginBottom: 6, backgroundColor: "#0a0a0a" },
  entryCardFirst: { borderColor: "#3a3a3a" },
  entryCardAI:    { borderColor: "#8B2500", backgroundColor: "#1a0a00" },
  entryText:      { color: "#ddd", fontSize: 14, lineHeight: 20 },
  entryTextAI:    { color: "#ff6b35" },
  entryAILabel:   { color: "#8B2500", fontSize: 10, fontWeight: "700", marginBottom: 4, letterSpacing: 0.5 },

  deleteBtn:     { alignItems: "flex-end", justifyContent: "center", flex: 1, backgroundColor: "#ff3b30", paddingRight: 20, marginBottom: 6, borderRadius: 10 },
  deleteBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },

  emptyState: { flex: 1, justifyContent: "center", alignItems: "center" },
  emptyText:  { color: "#333", fontSize: 17, textAlign: "center", lineHeight: 26 },

  suggSection: { backgroundColor: "#060e1a", borderTopWidth: 0.5, borderTopColor: "#0d1a2e", paddingHorizontal: 14, paddingTop: 10, paddingBottom: 6 },
  suggHeader:  { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  suggLabel:   { color: "#3a6ea8", fontSize: 10, fontWeight: "600", letterSpacing: 0.8 },
  refreshBtn:  { flexDirection: "row", alignItems: "center" },
  suggRefresh: { color: "#2a5080", fontSize: 11, fontWeight: "600" },

  // 縦並び・全幅・テキスト折り返し
  suggRow:   { flexDirection: "row", alignItems: "center", paddingVertical: 8, borderTopWidth: 0.5, borderTopColor: "#0d1a2e" },
  suggText:  { flex: 1, color: "#7eb8ff", fontSize: 13, lineHeight: 19 },
  suggArrow: { color: "#1e3a5a", fontSize: 16, marginLeft: 10 },

  inputWrapper:   { borderTopWidth: 0.5, borderTopColor: "#1e1e1e", paddingHorizontal: 14, paddingTop: 8, backgroundColor: "#000" },
  inputRow:       { flexDirection: "row", gap: 8, alignItems: "center" },
  suggTriggerBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: "#0a1628", borderWidth: 1, borderColor: "#1a3a6a" },
  suggTriggerText:{ color: "#7eb8ff", fontSize: 12, fontWeight: "600" },
  aiCardEmpty:    { paddingVertical: 10, alignItems: "center", marginBottom: 8 },
  aiCardEmptyText:{ color: "#2a4a6a", fontSize: 12 },
  input:        { height: 44, backgroundColor: "#111", borderRadius: 22, paddingHorizontal: 18, color: "#fff", fontSize: 14, borderWidth: 1, borderColor: "#2a2a2a" },

  aiCard:           { marginHorizontal: 14, marginTop: 10, marginBottom: 6, backgroundColor: "#060e1a", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#1a2a4a" },
  aiCardHeader:     { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  aiCardLabel:      { color: "#3a6ea8", fontSize: 10, fontWeight: "700", letterSpacing: 0.8 },
  aiCardRefreshText:{ color: "#2a4a6a", fontSize: 10 },
  aiCardLoading:    { color: "#333", fontSize: 12 },
  aiCardSummary:    { color: "#7eb8ff", fontSize: 14, fontWeight: "700", marginBottom: 2 },
  aiCardStyle:      { color: "#4a7ab0", fontSize: 12, lineHeight: 17 },
});
