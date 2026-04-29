// app/settings.tsx
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import * as WebBrowser from "expo-web-browser";
import React, { useEffect, useState } from "react";
import {
  Alert,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const SPOTIFY_CLIENT_ID = process.env.EXPO_PUBLIC_SPOTIFY_CLIENT_ID ?? "";
const SPOTIFY_REDIRECT  = "aichatapp://spotify-auth";
const SPOTIFY_TOKEN_KEY  = "spotify_token";
const AI_PERSONA_KEY    = "user_ai_persona";
const MODEL_KEY         = "ai_model_setting";
const APIKEY_CLAUDE      = "ai_apikey_claude";
const APIKEY_GEMINI      = "ai_apikey_gemini";
const APIKEY_OPENAI      = "ai_apikey_openai";
const APIKEY_GROQ        = "ai_apikey_groq";
const USAGE_KEY          = "ai_usage_stats";

// 将来の連携サービス（現在は未実装）
const FUTURE_SERVICES = [
  { id: "apple_music", label: "Apple Music",    desc: "再生履歴・プレイリストを取り込む",   available: false },
  { id: "calendar",    label: "カレンダー",      desc: "行動パターンを分析に活用する",         available: false },
  { id: "amazon",      label: "Amazon Prime",   desc: "視聴履歴を作品リストに追加する",       available: false },
];

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const [spotifyToken,    setSpotifyToken]    = useState<string | null>(null);
  const [spotifyLoading,  setSpotifyLoading]  = useState(false);
  const [aiPersonaText,   setAiPersonaText]   = useState("");   // あなたAIキャラ設定
  const [aiModel,     setAiModel]     = useState("claude");
  const [apiKeys,     setApiKeys]     = useState<Record<string,string>>({ claude: "", gemini: "", openai: "", groq: "" });
  const [showApiKey,  setShowApiKey]  = useState(false);
  const [usage, setUsage] = useState<{
    gemini: { minuteRequests: number; minuteStart: number; totalRequests: number };
    claude: { inputTokens: number; outputTokens: number; cost: number };
    openai: { inputTokens: number; outputTokens: number; cost: number };
  } | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(SPOTIFY_TOKEN_KEY).then((t) => { if (t) setSpotifyToken(t); });
    AsyncStorage.getItem(AI_PERSONA_KEY).then((v) => { if (v) setAiPersonaText(v); });
    AsyncStorage.getItem(USAGE_KEY).then((j) => { if (j) try { setUsage(JSON.parse(j)); } catch {} });
    AsyncStorage.getItem(MODEL_KEY).then((m) => { if (m) setAiModel(m); });
    Promise.all([
      AsyncStorage.getItem(APIKEY_CLAUDE),
      AsyncStorage.getItem(APIKEY_GEMINI),
      AsyncStorage.getItem(APIKEY_OPENAI),
      AsyncStorage.getItem(APIKEY_GROQ),
    ]).then(([cl, ge, op, gr]) => {
      setApiKeys({ claude: cl ?? "", gemini: ge ?? "", openai: op ?? "", groq: gr ?? "" });
    });
  }, []);

  const connectSpotify = async () => {
    setSpotifyLoading(true);
    try {
      const codeVerifier = Crypto.randomUUID().replace(/-/g, "") + Crypto.randomUUID().replace(/-/g, "");
      const digest       = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256, codeVerifier,
        { encoding: Crypto.CryptoEncoding.BASE64 }
      );
      const codeChallenge = digest.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

      const authUrl =
        `https://accounts.spotify.com/authorize` +
        `?client_id=${SPOTIFY_CLIENT_ID}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(SPOTIFY_REDIRECT)}` +
        `&scope=user-read-email%20user-library-read%20user-top-read%20user-read-recently-played` +
        `&code_challenge_method=S256` +
        `&code_challenge=${codeChallenge}`;

      const result = await WebBrowser.openAuthSessionAsync(authUrl, SPOTIFY_REDIRECT);
      if (result.type === "success" && result.url) {
        const match = result.url.match(/code=([^&]+)/);
        if (!match) return;
        const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
          method:  "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code", code: match[1],
            redirect_uri: SPOTIFY_REDIRECT, client_id: SPOTIFY_CLIENT_ID,
            code_verifier: codeVerifier,
          }).toString(),
        });
        const data = await tokenRes.json();
        if (data.access_token) {
          setSpotifyToken(data.access_token);
          await AsyncStorage.setItem(SPOTIFY_TOKEN_KEY, data.access_token);
          Alert.alert("✅ 連携完了", "Spotifyのデータをマイワールドの音楽タブに取り込みました");
        }
      }
    } catch (e) {
      Alert.alert("エラー", "Spotify連携に失敗しました");
    } finally {
      setSpotifyLoading(false);
    }
  };

  const disconnectSpotify = async () => {
    Alert.alert("連携を解除", "Spotifyとの連携を解除しますか？", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "解除", style: "destructive",
        onPress: async () => {
          await AsyncStorage.removeItem(SPOTIFY_TOKEN_KEY);
          setSpotifyToken(null);
        },
      },
    ]);
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 40 }]}
    >
      <Text style={styles.headerTitle}>設定</Text>


      {/* ── あなたAIの設定 ── */}
      <Text style={styles.sectionTitle}>あなたAI</Text>

      {/* キャラクター指定 */}
      <View style={styles.serviceCard}>
        <View style={{ flex: 1 }}>
          <Text style={styles.serviceLabel}>キャラクター設定</Text>
          <Text style={styles.serviceDesc}>{"空欄にするとAI分析から自動生成\n（マイリスト・自己紹介・フィード回答を参照）"}</Text>
          <TextInput
            style={stylesSet.personaInput}
            placeholder={"例: 少し皮肉っぽいが根は優しい。映画マニア。あまり感情を表に出さない。"}
            placeholderTextColor="#333"
            value={aiPersonaText}
            onChangeText={(v) => {
              setAiPersonaText(v);
              AsyncStorage.setItem(AI_PERSONA_KEY, v);
            }}
            multiline
            returnKeyType="done"
            blurOnSubmit
          />
          {aiPersonaText.length > 0 && (
            <TouchableOpacity onPress={() => { setAiPersonaText(""); AsyncStorage.setItem(AI_PERSONA_KEY, ""); }}>
              <Text style={stylesSet.clearText}>クリア（AI分析に戻す）</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* AIモデル */}
      <Text style={styles.sectionSubtitle}>使用するAIモデル</Text>
      {([
        {
          id: "claude", label: "Claude Sonnet", sub: "高品質",
          keyUrl: "https://console.anthropic.com/settings/keys",
          keyHint: "console.anthropic.comでキーを取得（有料）",
        },
        {
          id: "gemini", label: "Gemini 2.0 Flash", sub: "無料枠あり・高速",
          keyUrl: "https://aistudio.google.com/apikey",
          keyHint: "aistudio.google.comで無料取得",
        },
        {
          id: "openai", label: "GPT-4o-mini", sub: "低コスト",
          keyUrl: "https://platform.openai.com/api-keys",
          keyHint: "platform.openai.comでキーを取得（有料）",
        },
        {
          id: "groq", label: "Groq (Llama 70B)", sub: "無料1日14,400リクエスト",
          keyUrl: "https://console.groq.com/keys",
          keyHint: "console.groq.comで無料取得",
        },
      ] as const).map((m) => (
        <View key={m.id}>
          <TouchableOpacity
            style={[stylesSet.modelItem, aiModel === m.id && stylesSet.modelItemActive]}
            onPress={() => { setAiModel(m.id); AsyncStorage.setItem(MODEL_KEY, m.id); }}>
            <View style={[stylesSet.modelRadio, aiModel === m.id && stylesSet.modelRadioActive]}>
              {aiModel === m.id && <View style={stylesSet.modelRadioDot} />}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.serviceLabel, aiModel === m.id && { color: "#fff" }]}>{m.label}</Text>
              <Text style={styles.serviceDesc}>{m.sub}</Text>
            </View>
          </TouchableOpacity>

          {/* 選択中モデルのAPIキー設定 */}
          {aiModel === m.id && (
            <View style={stylesSet.apiBlock}>
              <View style={stylesSet.apiKeyRow}>
                <TextInput
                  style={stylesSet.apiKeyInput}
                  placeholder="APIキーを入力..."
                  placeholderTextColor="#444"
                  value={apiKeys[m.id] ?? ""}
                  onChangeText={(v) => {
                    const next = { ...apiKeys, [m.id]: v };
                    setApiKeys(next);
                    const key = m.id === "claude" ? APIKEY_CLAUDE : m.id === "gemini" ? APIKEY_GEMINI : m.id === "groq" ? APIKEY_GROQ : APIKEY_OPENAI;
                    AsyncStorage.setItem(key, v);
                  }}
                  secureTextEntry={!showApiKey}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TouchableOpacity onPress={() => setShowApiKey((v) => !v)} style={{ paddingHorizontal: 8 }}>
                  <Text style={{ color: "#555", fontSize: 12 }}>{showApiKey ? "隠す" : "表示"}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => {
                    const next = { ...apiKeys, [m.id]: "" };
                    setApiKeys(next);
                    const storageKey = m.id === "claude" ? APIKEY_CLAUDE : m.id === "gemini" ? APIKEY_GEMINI : APIKEY_OPENAI;
                    AsyncStorage.removeItem(storageKey);
                  }}
                  style={{ paddingHorizontal: 8 }}
                >
                  <Text style={{ color: "#5a1a1a", fontSize: 12 }}>クリア</Text>
                </TouchableOpacity>
              </View>
              {(apiKeys[m.id]?.length ?? 0) > 0 ? (
                <Text style={stylesSet.apiStatusOk}>✓ APIキー設定済み</Text>
              ) : (
                <View style={stylesSet.apiStatusRow}>
                  <Text style={stylesSet.apiStatusNg}>未設定 — </Text>
                  <TouchableOpacity onPress={() => Linking.openURL(m.keyUrl)}>
                    <Text style={stylesSet.apiStatusLink}>{m.keyHint}</Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* 使用量表示 */}
              {usage && m.id === "gemini" && (
                <View style={stylesSet.usageBox}>
                  <Text style={stylesSet.usageText}>
                    {"この1分: " + usage.gemini.minuteRequests + " / 15 リクエスト"}
                  </Text>
                  <Text style={stylesSet.usageSubText}>
                    {"推定残り: " + Math.max(0, 15 - usage.gemini.minuteRequests) + " 件  |  累計: " + usage.gemini.totalRequests + " リクエスト"}
                  </Text>
                </View>
              )}
              {usage && (m.id === "claude" || m.id === "openai") && (
                <View style={stylesSet.usageBox}>
                  <Text style={stylesSet.usageText}>
                    {"入力: " + (usage[m.id as "claude"|"openai"].inputTokens).toLocaleString() + " tokens  |  出力: " + (usage[m.id as "claude"|"openai"].outputTokens).toLocaleString() + " tokens"}
                  </Text>
                  <Text style={stylesSet.usageSubText}>
                    {"累計コスト: $" + (usage[m.id as "claude"|"openai"].cost).toFixed(4)}
                  </Text>
                </View>
              )}
              {usage && m.id === "groq" && (
                <View style={stylesSet.usageBox}>
                  <Text style={stylesSet.usageText}>完全無料（1日14,400リクエスト）</Text>
                  <Text style={stylesSet.usageSubText}>console.groq.comで取得</Text>
                </View>
              )}
            </View>
          )}
        </View>
      ))}

      {/* データ連携セクション */}
      <Text style={styles.sectionTitle}>データ連携</Text>

      {/* Spotify */}
      <View style={styles.serviceCard}>
        <View style={styles.serviceInfo}>
          <Text style={styles.serviceLabel}>Spotify</Text>
          <Text style={styles.serviceDesc}>
            トップ曲・最近再生した曲を{"\n"}音楽タブに自動取り込み
          </Text>
        </View>
        {spotifyToken ? (
          <View style={styles.serviceActions}>
            <View style={styles.connectedBadge}>
              <Text style={styles.connectedBadgeTxt}>連携中</Text>
            </View>
            <TouchableOpacity style={styles.disconnectBtn} onPress={disconnectSpotify}>
              <Text style={styles.disconnectBtnTxt}>解除</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.connectBtn, { backgroundColor: "#1DB954" }, spotifyLoading && styles.connectBtnDisabled]}
            onPress={connectSpotify}
            disabled={spotifyLoading}
          >
            <Text style={styles.connectBtnTxt}>{spotifyLoading ? "連携中..." : "連携する"}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* 将来の連携（グレーアウト） */}
      <Text style={styles.sectionSubtitle}>近日対応予定</Text>
      {FUTURE_SERVICES.map((svc) => (
        <View key={svc.id} style={[styles.serviceCard, styles.serviceCardDisabled]}>
          <View style={styles.serviceInfo}>
            <Text style={[styles.serviceLabel, styles.serviceLabelDisabled]}>{svc.label}</Text>
            <Text style={[styles.serviceDesc, styles.serviceDescDisabled]}>{svc.desc}</Text>
          </View>
          <View style={[styles.connectBtn, styles.connectBtnDisabled]}>
            <Text style={[styles.connectBtnTxt, { color: "#555" }]}>準備中</Text>
          </View>
        </View>
      ))}

      {/* 使用量リセット */}
      {usage && (
        <TouchableOpacity style={{ paddingVertical: 8, alignItems: "flex-end", paddingHorizontal: 4 }}
          onPress={async () => {
            await AsyncStorage.removeItem(USAGE_KEY);
            setUsage(null);
          }}>
          <Text style={{ color: "#2a4a6a", fontSize: 11 }}>使用量をリセット</Text>
        </TouchableOpacity>
      )}

      {/* データ管理 */}
      <Text style={styles.sectionTitle}>データ管理</Text>
      <TouchableOpacity
        style={styles.dangerBtn}
        onPress={() => Alert.alert(
          "データを削除",
          "すべてのデータ（リスト・AI履歴・分析）を削除しますか？この操作は取り消せません。",
          [
            { text: "キャンセル", style: "cancel" },
            {
              text: "削除する", style: "destructive",
              onPress: async () => {
                await Promise.all([
                  AsyncStorage.clear(),
                ]);
                Alert.alert("削除完了", "すべてのデータを削除しました");
              },
            },
          ]
        )}
      >
        <Text style={styles.dangerBtnTxt}>すべてのデータを削除</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const stylesSet = StyleSheet.create({
  personaInput:    { marginTop: 8, backgroundColor: "#111", borderRadius: 10, padding: 12, color: "#fff", fontSize: 13, borderWidth: 1, borderColor: "#2a2a2a", minHeight: 80, lineHeight: 20 },
  clearText:       { color: "#444", fontSize: 11, marginTop: 6, textAlign: "right" },
  modelItem:       { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 4 },
  modelItemActive: {},
  modelRadio:      { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: "#444", alignItems: "center", justifyContent: "center" },
  modelRadioActive:{ borderColor: "#fff" },
  modelRadioDot:   { width: 9, height: 9, borderRadius: 5, backgroundColor: "#fff" },
  apiBlock:         { marginTop: 6, marginBottom: 4, paddingHorizontal: 4 },
  apiKeyRow:        { flexDirection: "row", alignItems: "center", backgroundColor: "#0d0d0d", borderRadius: 10, borderWidth: 1, borderColor: "#2a2a2a", paddingLeft: 4 },
  apiStatusOk:      { color: "#4caf50", fontSize: 11, marginTop: 5, paddingLeft: 4 },
  apiStatusRow:     { flexDirection: "row", alignItems: "center", marginTop: 5, paddingLeft: 4 },
  apiStatusNg:      { color: "#555", fontSize: 11 },
  apiStatusLink:    { color: "#3a6ea8", fontSize: 11, textDecorationLine: "underline" },
  apiKeyInput:     { flex: 1, height: 40, color: "#fff", fontSize: 13, paddingHorizontal: 10 },
  apiHint:         { color: "#333", fontSize: 11, marginTop: 4 },
  usageBox:        { marginTop: 8, padding: 8, backgroundColor: "#0a0a0a", borderRadius: 8, borderWidth: 1, borderColor: "#1e1e1e" },
  usageText:       { color: "#888", fontSize: 12, fontWeight: "600" },
  usageSubText:    { color: "#555", fontSize: 11, marginTop: 2 },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  content:   { paddingHorizontal: 16 },

  headerTitle:  { color: "#fff", fontSize: 26, fontWeight: "700", marginBottom: 24 },
  sectionTitle: { color: "#888", fontSize: 12, fontWeight: "700", letterSpacing: 1, marginBottom: 10, marginTop: 24, textTransform: "uppercase" },
  sectionSubtitle: { color: "#444", fontSize: 11, marginBottom: 8, marginTop: 16 },

  serviceCard: {
    flexDirection:   "row",
    alignItems:      "center",
    backgroundColor: "#0d0d0d",
    borderRadius:    14,
    padding:         16,
    marginBottom:    10,
    borderWidth:     1,
    borderColor:     "#1e1e1e",
  },
  serviceCardDisabled: { opacity: 0.5 },
  serviceInfo:  { flex: 1 },
  serviceLabel: { color: "#fff", fontSize: 15, fontWeight: "600", marginBottom: 4 },
  serviceLabelDisabled: { color: "#555" },
  serviceDesc:  { color: "#666", fontSize: 12, lineHeight: 18 },
  serviceDescDisabled: { color: "#444" },

  serviceActions:    { alignItems: "flex-end", gap: 6 },
  connectedBadge:    { backgroundColor: "#0d2b0d", borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: "#1a4d1a" },
  connectedBadgeTxt: { color: "#4caf50", fontSize: 12, fontWeight: "600" },
  disconnectBtn:     { paddingHorizontal: 10, paddingVertical: 4 },
  disconnectBtnTxt:  { color: "#555", fontSize: 12 },

  connectBtn:         { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: "#1a1a1a" },
  connectBtnDisabled: { backgroundColor: "#111" },
  connectBtnTxt:      { color: "#fff", fontWeight: "600", fontSize: 13 },

  dangerBtn:    { marginTop: 8, paddingVertical: 14, borderRadius: 14, backgroundColor: "#1a0000", borderWidth: 1, borderColor: "#3a0000", alignItems: "center" },
  dangerBtnTxt: { color: "#ff3b30", fontSize: 14, fontWeight: "600" },
});
