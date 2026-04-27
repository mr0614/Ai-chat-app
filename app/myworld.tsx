/**
 * myworld.tsx
 *
 * 検索方式（Amazon完全準拠）:
 *   - 起動時: TMDB人気作をSQLiteにキャッシュ（タイトル+画像URL）
 *   - 入力中: SQLiteをINSTANT検索 → setResults を1回だけ呼ぶ
 *   - 入力停止200ms後: APIで補完（setResultsは呼ばず、imageUrlだけ裏で更新）
 *   - setResults の呼び出しは handleSearch の中の1箇所のみ
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import axios from "axios";
import * as AuthSession from "expo-auth-session";
import * as Crypto from "expo-crypto";
import * as SQLite from "expo-sqlite";
import * as WebBrowser from "expo-web-browser";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
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
  useWindowDimensions,
} from "react-native";
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SwipeListView } from "react-native-swipe-list-view";
import * as wanakana from "wanakana";

WebBrowser.maybeCompleteAuthSession();

// ─── 定数 ────────────────────────────────────────────────────────────────────
const TMDB_KEY          = process.env.EXPO_PUBLIC_TMDB_API_KEY ?? "";
const GBOOKS_KEY        = process.env.EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY ?? "";
const SPOTIFY_CLIENT_ID = process.env.EXPO_PUBLIC_SPOTIFY_CLIENT_ID ?? "";
const SPOTIFY_REDIRECT  = AuthSession.makeRedirectUri({ scheme: "aichatapp" });

const TABS = [
  { id: "all",     label: "すべて" },
  { id: "video",   label: "映像" },
  { id: "book",    label: "本" },
  { id: "music",   label: "音楽" },
  { id: "person",  label: "人物" },
  { id: "theater", label: "演劇" },
] as const;

type TabId = typeof TABS[number]["id"];
type CategoryId = Exclude<TabId, "all">;

const CATEGORY_LABELS: Record<CategoryId, string> = {
  video: "映像", book: "本", music: "音楽", person: "人物", theater: "演劇",
};

const discovery = {
  authorizationEndpoint: "https://accounts.spotify.com/authorize",
  tokenEndpoint:         "https://accounts.spotify.com/api/token",
};

// ─── 型 ──────────────────────────────────────────────────────────────────────
interface ListItem {
  id:          string;
  title:       string;
  subtitle?:   string;
  imageUrl?:   string;
  category:    CategoryId;
  isSeries?:   boolean;   // シリーズまとめ登録フラグ
  seriesCount?: number;   // シーズン数 or 巻数
}

interface CastMember {
  id: number; name: string; character?: string; profileUrl?: string;
}

interface ItemDetail extends ListItem {
  overview?: string; director?: string; directorId?: number; directorProfileUrl?: string;
  cast: CastMember[]; fullImageUrl?: string;
}

// ─── SQLite DB ────────────────────────────────────────────────────────────────
let db: SQLite.SQLiteDatabase | null = null;

async function getDB(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  db = await SQLite.openDatabaseAsync("myworld.db");
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS titles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      title_kana TEXT,
      title_romaji TEXT,
      subtitle TEXT,
      image_url TEXT,
      category TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_title ON titles(title);
  `);
  return db;
}

async function upsertTitles(items: { id: string; title: string; subtitle?: string; imageUrl?: string; category: CategoryId }[]) {
  const d = await getDB();
  await d.withTransactionAsync(async () => {
    for (const item of items) {
      const kana   = wanakana.toHiragana(item.title);
      const romaji = wanakana.toRomaji(item.title);
      await d.runAsync(
        `INSERT OR REPLACE INTO titles (id, title, title_kana, title_romaji, subtitle, image_url, category)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [item.id, item.title, kana, romaji, item.subtitle ?? null, item.imageUrl ?? null, item.category]
      );
    }
  });
}

async function searchTitles(query: string, category: TabId): Promise<ListItem[]> {
  const d = await getDB();
  const q = query.trim();
  if (q.length < 2) return [];

  // 前方一致のみ（部分一致は関係ない候補が大量に出るため禁止）
  // ひらがな変換も試みる（例:「あば」→「アバター」にマッチ）
  const kana  = wanakana.toHiragana(q);
  const kataQ = wanakana.toKatakana(q);

  const likeQ  = `${q}%`;
  const likeK  = `${kana}%`;
  const likeKa = `${kataQ}%`;
  // 中間一致は日本語タイトルに限定（「鬼」→「鬼滅の刃」）
  const likeJa = `%${q}%`;

  const where = category === "all" ? "" : `AND category = '${category}'`;

  const rows = await d.getAllAsync<any>(
    `SELECT id, title, subtitle, category FROM titles
     WHERE (
       title        LIKE ? OR
       title        LIKE ? OR
       title        LIKE ? OR
       title_kana   LIKE ? OR
       title_kana   LIKE ? OR
       title_romaji LIKE ?
     ) ${where}
     ORDER BY
       CASE
         WHEN title LIKE ? THEN 0
         WHEN title_kana LIKE ? THEN 1
         ELSE 2
       END
     LIMIT 30`,
    [likeQ, likeK, likeKa, likeQ, likeK, likeQ,
     likeQ, likeK]
  );

  // 画像はここでは返さない（文字だけで高速返却）
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    subtitle: r.subtitle ?? undefined,
    imageUrl: undefined, // ← 意図的にnull
    category: r.category as CategoryId,
  }));
}

async function updateImageUrl(id: string, imageUrl: string) {
  const d = await getDB();
  await d.runAsync(`UPDATE titles SET image_url = ? WHERE id = ?`, [imageUrl, id]);
}

// ─── TMDB キャッシュ構築 ──────────────────────────────────────────────────────
async function warmUpCache() {
  const d = await getDB();
  const count = await d.getFirstAsync<{ n: number }>(`SELECT COUNT(*) as n FROM titles WHERE category = 'video'`);
  if ((count?.n ?? 0) > 100) return; // 既にキャッシュ済み

  const items: { id: string; title: string; subtitle?: string; imageUrl?: string; category: CategoryId }[] = [];
  for (const type of ["movie", "tv"] as const) {
    await Promise.all(
      Array.from({ length: 15 }, (_, i) => i + 1).map(async (page) => {
        try {
          const res = await axios.get(`https://api.themoviedb.org/3/discover/${type}`, {
            params: { api_key: TMDB_KEY, sort_by: "popularity.desc", language: "ja-JP", page },
          });
          (res.data.results ?? []).forEach((item: any) => {
            const title = type === "movie" ? (item.title ?? "") : (item.name ?? "");
            const year  = (type === "movie" ? item.release_date : item.first_air_date)?.slice(0, 4);
            items.push({
              id:       `${type}_${item.id}`,
              title,
              subtitle: year,
              imageUrl: item.poster_path ? `https://image.tmdb.org/t/p/w200${item.poster_path}` : undefined,
              category: "video",
            });
          });
        } catch {}
      })
    );
  }
  if (items.length > 0) await upsertTitles(items);
}

// ─── TMDB 詳細 ────────────────────────────────────────────────────────────────
async function fetchTMDBDetail(type: "movie" | "tv", tmdbId: string): Promise<Partial<ItemDetail>> {
  try {
    const [dr, cr] = await Promise.all([
      axios.get(`https://api.themoviedb.org/3/${type}/${tmdbId}`, { params: { api_key: TMDB_KEY, language: "ja-JP" } }),
      axios.get(`https://api.themoviedb.org/3/${type}/${tmdbId}/credits`, { params: { api_key: TMDB_KEY, language: "ja-JP" } }),
    ]);
    const d    = dr.data;
    const crew = cr.data.crew ?? [];
    const cast = cr.data.cast ?? [];
    const dir  = crew.find((c: any) => c.job === "Director") ?? crew.find((c: any) => c.department === "Directing");
    return {
      title:               type === "movie" ? d.title : d.name,
      subtitle:            (type === "movie" ? d.release_date : d.first_air_date)?.slice(0, 4),
      overview:            d.overview,
      imageUrl:            d.poster_path ? `https://image.tmdb.org/t/p/w300${d.poster_path}` : undefined,
      fullImageUrl:        d.poster_path ? `https://image.tmdb.org/t/p/original${d.poster_path}` : undefined,
      director:            dir?.name,
      directorId:          dir?.id,
      directorProfileUrl:  dir?.profile_path ? `https://image.tmdb.org/t/p/w45${dir.profile_path}` : undefined,
      cast: cast.slice(0, 12).map((c: any) => ({
        id: c.id, name: c.name, character: c.character,
        profileUrl: c.profile_path ? `https://image.tmdb.org/t/p/w45${c.profile_path}` : undefined,
      })),
    };
  } catch { return { cast: [] }; }
}

async function fetchPersonCredits(personId: number): Promise<{ cast: ListItem[]; directed: ListItem[] }> {
  try {
    const res = await axios.get(`https://api.themoviedb.org/3/person/${personId}/combined_credits`, {
      params: { api_key: TMDB_KEY, language: "ja-JP" },
    });
    const toItem = (item: any): ListItem => ({
      id: `${item.media_type}_${item.id}`, title: item.title ?? item.name ?? "不明",
      subtitle: item.character ? `役: ${item.character}` : (item.release_date ?? item.first_air_date)?.slice(0, 4),
      imageUrl: item.poster_path ? `https://image.tmdb.org/t/p/w92${item.poster_path}` : undefined,
      category: "video",
    });
    const cast = (res.data.cast ?? []).sort((a: any, b: any) => b.popularity - a.popularity).slice(0, 30).map(toItem);
    const directed = (res.data.crew ?? []).filter((c: any) => c.job === "Director")
      .sort((a: any, b: any) => b.popularity - a.popularity).slice(0, 20)
      .map((item: any) => ({ ...toItem(item), subtitle: (item.release_date ?? item.first_air_date)?.slice(0, 4) }));
    return { cast, directed };
  } catch { return { cast: [], directed: [] }; }
}

const THEATER_MOCK: ListItem[] = [
  { id: "theater_1", title: "ハミルトン",             subtitle: "ミュージカル", category: "theater" },
  { id: "theater_2", title: "レ・ミゼラブル",         subtitle: "ミュージカル", category: "theater" },
  { id: "theater_3", title: "劇団四季 ライオンキング", subtitle: "ミュージカル", category: "theater" },
  { id: "theater_4", title: "NODA MAP",               subtitle: "演劇",         category: "theater" },
  { id: "theater_5", title: "宝塚歌劇団",             subtitle: "歌劇",         category: "theater" },
];

// ─── ピンチ＋パン画像 ────────────────────────────────────────────────────────
function ZoomableImage({ uri }: { uri: string }) {
  const scale = useSharedValue(1); const saved = useSharedValue(1);
  const tx = useSharedValue(0);    const ty = useSharedValue(0);
  const stx = useSharedValue(0);   const sty = useSharedValue(0);
  const reset = () => {
    scale.value = withSpring(1); saved.value = 1;
    tx.value = withSpring(0); ty.value = withSpring(0); stx.value = 0; sty.value = 0;
  };
  const pinch = Gesture.Pinch()
    .onUpdate((e) => { scale.value = Math.max(0.5, saved.value * e.scale); })
    .onEnd(() => { saved.value = Math.max(1, Math.min(scale.value, 5)); if (scale.value < 1) reset(); });
  const pan = Gesture.Pan()
    .onUpdate((e) => { tx.value = stx.value + e.translationX; ty.value = sty.value + e.translationY; })
    .onEnd(() => { stx.value = tx.value; sty.value = ty.value; });
  const dbl = Gesture.Tap().numberOfTaps(2).onEnd(reset);
  const anim = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));
  return (
    <GestureDetector gesture={Gesture.Simultaneous(Gesture.Simultaneous(pinch, pan), dbl)}>
      <Animated.Image source={{ uri }} style={[styles.modalImage, anim]} resizeMode="contain" />
    </GestureDetector>
  );
}

// ─── 詳細モーダル ─────────────────────────────────────────────────────────────
type NavEntry =
  | { type: "detail"; item: ItemDetail }
  | { type: "person"; id: number; name: string; castList: ListItem[]; directedList: ListItem[]; tab: "cast" | "directed" };

function DetailModal({ initialItem, onClose, onAddToList, alreadyAdded }: {
  initialItem: ItemDetail | null; onClose: () => void;
  onAddToList: (item: ListItem) => void; alreadyAdded: (id: string) => boolean;
}) {
  const insets = useSafeAreaInsets();
  const [navStack, setNavStack] = useState<NavEntry[]>([]);
  const [loading,  setLoading]  = useState(false);

  useEffect(() => { if (initialItem) setNavStack([{ type: "detail", item: initialItem }]); }, [initialItem]);

  if (!initialItem || navStack.length === 0) return null;
  const current = navStack[navStack.length - 1];

  const pushPerson = async (id: number, name: string, defaultTab: "cast" | "directed") => {
    setLoading(true);
    const { cast, directed } = await fetchPersonCredits(id);
    setNavStack((prev) => [...prev, { type: "person", id, name, castList: cast, directedList: directed, tab: defaultTab }]);
    setLoading(false);
  };

  const pushDetail = async (film: ListItem) => {
    if (film.category !== "video") return;
    setLoading(true);
    const isTV = film.id.startsWith("tv_");
    const nid  = film.id.replace(/^(movie|tv)_/, "");
    const detail = await fetchTMDBDetail(isTV ? "tv" : "movie", nid);
    setNavStack((prev) => [...prev, { type: "detail", item: { ...film, cast: [], ...detail } as ItemDetail }]);
    setLoading(false);
  };

  const setPersonTab = (tab: "cast" | "directed") => {
    setNavStack((prev) => {
      const last = prev[prev.length - 1];
      if (last.type !== "person") return prev;
      return [...prev.slice(0, -1), { ...last, tab }];
    });
  };

  const handleBack = () => setNavStack((prev) => prev.slice(0, -1));

  return (
    <Modal visible animationType="slide" transparent>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View style={styles.modalBg}>
          {loading && <View style={styles.modalLoadingOverlay}><ActivityIndicator color="#fff" size="large" /></View>}

          {current.type === "detail" && (
            <ScrollView style={styles.modalScroll} contentContainerStyle={[styles.modalScrollContent, { paddingTop: insets.top + 20 }]} showsVerticalScrollIndicator={false}>
              {current.item.imageUrl
                ? <ZoomableImage uri={current.item.fullImageUrl ?? current.item.imageUrl} />
                : <View style={styles.modalNoImage}><Text style={{ fontSize: 48 }}>{CATEGORY_LABELS[current.item.category]?.slice(0, 1)}</Text></View>
              }
              <Text style={styles.modalTitle}>{current.item.title}</Text>
              {current.item.subtitle && <Text style={styles.modalYear}>{current.item.subtitle}</Text>}
              <TouchableOpacity style={[styles.addBtn, alreadyAdded(current.item.id) && styles.addBtnDone]} onPress={() => onAddToList(current.item)}>
                <Text style={styles.addBtnText}>{alreadyAdded(current.item.id) ? "✓ 追加済み" : "+ マイリストに追加"}</Text>
              </TouchableOpacity>
              {current.item.director && (
                <View style={styles.castSection}>
                  <Text style={styles.castLabel}>監督</Text>
                  <View style={styles.castList}>
                    <TouchableOpacity style={styles.castChip} onPress={() => current.item.directorId && pushPerson(current.item.directorId, current.item.director!, "directed")}>
                      {current.item.directorProfileUrl && <Image source={{ uri: current.item.directorProfileUrl }} style={styles.castAvatar} />}
                      <Text style={styles.castName}>{current.item.director}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
              {current.item.overview ? <Text style={styles.overview} numberOfLines={5}>{current.item.overview}</Text> : null}
              {current.item.cast.length > 0 && (
                <View style={styles.castSection}>
                  <Text style={styles.castLabel}>出演者</Text>
                  <View style={styles.castList}>
                    {current.item.cast.map((p) => (
                      <TouchableOpacity key={p.id} style={styles.castChip} onPress={() => pushPerson(p.id, p.name, "cast")}>
                        {p.profileUrl && <Image source={{ uri: p.profileUrl }} style={styles.castAvatar} />}
                        <View>
                          <Text style={styles.castName}>{p.name}</Text>
                          {p.character && <Text style={styles.castChar} numberOfLines={1}>{p.character}</Text>}
                        </View>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              )}
            </ScrollView>
          )}

          {current.type === "person" && (
            <View style={[styles.filmoContainer, { paddingTop: insets.top + 20 }]}>
              <Text style={styles.filmoPersonName}>{current.name}</Text>
              <View style={styles.filmoTabRow}>
                <TouchableOpacity style={[styles.filmoTab, current.tab === "cast" && styles.filmoTabActive]} onPress={() => setPersonTab("cast")}>
                  <Text style={[styles.filmoTabText, current.tab === "cast" && styles.filmoTabTextActive]}>出演作</Text>
                </TouchableOpacity>
                {current.directedList.length > 0 && (
                  <TouchableOpacity style={[styles.filmoTab, current.tab === "directed" && styles.filmoTabActive]} onPress={() => setPersonTab("directed")}>
                    <Text style={[styles.filmoTabText, current.tab === "directed" && styles.filmoTabTextActive]}>監督作</Text>
                  </TouchableOpacity>
                )}
              </View>
              <FlatList
                data={current.tab === "cast" ? current.castList : current.directedList}
                keyExtractor={(item) => item.id}
                contentContainerStyle={{ paddingBottom: 120 }}
                renderItem={({ item: film }) => (
                  <TouchableOpacity style={styles.filmoRow} onPress={() => pushDetail(film)}>
                    {film.imageUrl
                      ? <Image source={{ uri: film.imageUrl }} style={styles.filmoThumb} />
                      : <View style={[styles.filmoThumb, styles.noImage]}><Text style={{ fontSize: 14 }}>🎬</Text></View>
                    }
                    <View style={styles.filmoText}>
                      <Text style={styles.filmoName} numberOfLines={2}>{film.title}</Text>
                      {film.subtitle && <Text style={styles.filmoSub} numberOfLines={1}>{film.subtitle}</Text>}
                    </View>
                    <Text style={styles.filmoArrow}>›</Text>
                  </TouchableOpacity>
                )}
              />
            </View>
          )}

          <View style={[styles.modalBottomBtns, { bottom: insets.bottom + 24 }]}>
            {navStack.length > 1 && (
              <TouchableOpacity style={styles.modalBottomBtn} onPress={handleBack}>
                <Text style={styles.modalBottomBtnText}>← 戻る</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.modalBottomBtn} onPress={onClose}>
              <Text style={styles.modalBottomBtnText}>✕ 閉じる</Text>
            </TouchableOpacity>
          </View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

// ─── メインコンポーネント ──────────────────────────────────────────────────────
export default function MyWorldScreen() {
  const { height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const [activeTab,       setActiveTab]       = useState<TabId>("all");
  const [query,           setQuery]           = useState("");
  const [results,         setResults]         = useState<ListItem[]>([]);
  const [myList,          setMyList]          = useState<ListItem[]>([]);

  // リストをAsyncStorageから復元
  useEffect(() => {
    AsyncStorage.getItem("myworld_list").then((json) => {
      if (json) { try { setMyList(JSON.parse(json)); } catch {} }
    });
  }, []);

  // リストが変わるたびに保存
  useEffect(() => {
    AsyncStorage.setItem("myworld_list", JSON.stringify(myList));
  }, [myList]);
  const [selectedItem,    setSelectedItem]    = useState<ItemDetail | null>(null);
  const [detailLoading,   setDetailLoading]   = useState(false);
  const [spotifyToken,    setSpotifyToken]    = useState<string | null>(null);
  const [cacheReady,      setCacheReady]      = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight,  setKeyboardHeight]  = useState(0);

  const inputRef         = useRef<TextInput>(null);
  const searchIdRef      = useRef(0);
  const resultsLockedRef = useRef(false); // trueの間はsetResultsを無効化
  const debounceRef      = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Spotify PKCE Flow（直接スキームリダイレクト）──
  const spotifyRedirect = `aichatapp://spotify-auth`;

  const openSpotifyAuth = async () => {
    const codeVerifier = Crypto.randomUUID().replace(/-/g, "") +
                         Crypto.randomUUID().replace(/-/g, "");

    const digest = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      codeVerifier,
      { encoding: Crypto.CryptoEncoding.BASE64 }
    );
    const codeChallenge = digest
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    const authUrl =
      `https://accounts.spotify.com/authorize` +
      `?client_id=${SPOTIFY_CLIENT_ID}` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(spotifyRedirect)}` +
      `&scope=user-read-email%20user-library-read%20user-top-read%20user-read-recently-played` +
      `&code_challenge_method=S256` +
      `&code_challenge=${codeChallenge}`;

    const result = await WebBrowser.openAuthSessionAsync(authUrl, spotifyRedirect);

    if (result.type === "success" && result.url) {
      const match = result.url.match(/code=([^&]+)/);
      if (!match) return;
      const code = match[1];

      const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type:    "authorization_code",
          code,
          redirect_uri:  spotifyRedirect,
          client_id:     SPOTIFY_CLIENT_ID,
          code_verifier: codeVerifier,
        }).toString(),
      });
      const tokenData = await tokenRes.json();
      if (tokenData.access_token) {
        setSpotifyToken(tokenData.access_token);
        importFromSpotify(tokenData.access_token);
      }
    }
  };

  // ── キーボード ──
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      (e) => { setKeyboardVisible(true); setKeyboardHeight(e.endCoordinates.height); });
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => {
        setKeyboardVisible(false); setKeyboardHeight(0);
        // クエリが空の時だけ候補を閉じる（スクロールでキーボードを閉じた場合は候補を残す）
        setQuery((q) => { if (q.trim().length < 2) setResults([]); return q; });
      });
    return () => { show.remove(); hide.remove(); };
  }, []);

  // ── 起動時キャッシュ構築 ──
  useEffect(() => {
    warmUpCache().finally(() => setCacheReady(true));
  }, []);

  // ── Spotify取り込み（トークン取得後に自動実行）──
  const importFromSpotify = useCallback(async (token: string) => {
    try {
      const [topRes, recentRes] = await Promise.all([
        axios.get("https://api.spotify.com/v1/me/top/tracks", {
          headers: { Authorization: `Bearer ${token}` },
          params:  { limit: 20, time_range: "medium_term" },
        }),
        axios.get("https://api.spotify.com/v1/me/player/recently-played", {
          headers: { Authorization: `Bearer ${token}` },
          params:  { limit: 20 },
        }),
      ]);

      const topItems: ListItem[] = (topRes.data.items ?? []).map((t: any) => ({
        id:       `music_track_${t.id}`,
        title:    `${t.name} — ${t.artists?.map((a: any) => a.name).join(", ")}`,
        subtitle: "Spotifyトップ曲",
        imageUrl: t.album?.images?.[2]?.url,
        category: "music" as CategoryId,
      }));

      const recentItems: ListItem[] = (recentRes.data.items ?? []).map((item: any) => ({
        id:       `music_track_${item.track.id}`,
        title:    `${item.track.name} — ${item.track.artists?.map((a: any) => a.name).join(", ")}`,
        subtitle: "最近再生",
        imageUrl: item.track.album?.images?.[2]?.url,
        category: "music" as CategoryId,
      }));

      // 既存リストをAsyncStorageから直接読んで重複除去してから保存
      const existingJson = await AsyncStorage.getItem("myworld_list");
      const existing: ListItem[] = existingJson ? JSON.parse(existingJson) : [];
      const existingIds = new Set(existing.map((m) => m.id));
      const seenIds = new Set<string>();
      const newItems = [...topItems, ...recentItems].filter((item) => {
        if (seenIds.has(item.id) || existingIds.has(item.id)) return false;
        seenIds.add(item.id);
        return true;
      });

      if (newItems.length > 0) {
        const merged = [...newItems, ...existing];
        await AsyncStorage.setItem("myworld_list", JSON.stringify(merged));
        setMyList(merged);
      }
    } catch (e) {
      console.warn("Spotify import error:", e);
    }
  }, []);

  // ──────────────────────────────────────────────────────────────────────────
  // 検索：setResults は この関数の中で 1回だけ 呼ぶ
  // ──────────────────────────────────────────────────────────────────────────
  const closeResults = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    searchIdRef.current += 1; // 進行中のAPIをすべて無効化
    setResults([]);
  }, []);

  const handleSearch = useCallback((text: string) => {
    setQuery(text);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    searchIdRef.current += 1;
    const myId = searchIdRef.current;

    // 2文字未満は検索しない
    if (text.trim().length < 2) {
      setResults([]);
      return;
    }

    // ① SQLite即時検索（画像なし・文字だけ・高速）
    searchTitles(text, activeTab).then((localRows) => {
      if (searchIdRef.current !== myId) return;
      if (resultsLockedRef.current) return; // ロック中は無視
      setResults(localRows);
    });

    // ② 300ms後にAPIで検索 → SQLiteに保存 → 既存リストに画像だけ静かに付与
    debounceRef.current = setTimeout(async () => {
      if (searchIdRef.current !== myId) return;
      try {
        let apiItems: ListItem[] = [];

        if (activeTab === "all" || activeTab === "video") {
          const res = await axios.get("https://api.themoviedb.org/3/search/multi", {
            params: { api_key: TMDB_KEY, query: text, language: "ja-JP" },
          });
          const raw = (res.data.results ?? []).filter((r: any) => r.media_type === "movie" || r.media_type === "tv");

          // TV番組にはシーズン数を取得してシリーズとして扱う
          apiItems = raw.map((item: any) => {
            const isTV       = item.media_type === "tv";
            const seasons    = item.number_of_seasons;
            const isSeries   = isTV && (seasons > 1 || item.number_of_episodes > 12);
            return {
              id:          `${item.media_type}_${item.id}`,
              title:       item.title ?? item.name ?? "",
              subtitle:    isTV
                ? (seasons ? `全${seasons}シーズン` : (item.first_air_date?.slice(0, 4) ?? ""))
                : (item.release_date?.slice(0, 4) ?? ""),
              imageUrl:    item.poster_path ? `https://image.tmdb.org/t/p/w200${item.poster_path}` : undefined,
              category:    "video" as CategoryId,
              isSeries,
              seriesCount: seasons,
            };
          });

          // シリーズを上位に並び替え
          apiItems.sort((a, b) => {
            if (a.isSeries && !b.isSeries) return -1;
            if (!a.isSeries && b.isSeries) return 1;
            return 0;
          });
        }
        if (activeTab === "book") {
          const res = await axios.get("https://www.googleapis.com/books/v1/volumes", {
            params: { q: text, key: GBOOKS_KEY, maxResults: 20 },
          });
          apiItems = (res.data.items ?? []).map((b: any) => ({
            id: `book_${b.id}`, title: b.volumeInfo?.title ?? "不明",
            subtitle: b.volumeInfo?.authors?.join(", "),
            imageUrl: b.volumeInfo?.imageLinks?.thumbnail?.replace("http://", "https://"),
            category: "book" as CategoryId,
          }));
        }
        if (activeTab === "music" && spotifyToken) {
          const res = await axios.get("https://api.spotify.com/v1/search", {
            headers: { Authorization: `Bearer ${spotifyToken}` },
            params: { q: text, type: "track,album", limit: 20, market: "JP" },
          });
          apiItems = [
            ...(res.data.tracks?.items ?? []).map((t: any) => ({
              id: `music_track_${t.id}`, title: t.name,
              subtitle: t.artists?.map((a: any) => a.name).join(", "),
              imageUrl: t.album?.images?.[2]?.url, category: "music" as CategoryId,
            })),
            ...(res.data.albums?.items ?? []).map((a: any) => ({
              id: `music_album_${a.id}`, title: a.name,
              subtitle: a.artists?.map((x: any) => x.name).join(", "),
              imageUrl: a.images?.[2]?.url, category: "music" as CategoryId,
            })),
          ];
        }
        if (activeTab === "person") {
          const res = await axios.get("https://api.themoviedb.org/3/search/person", {
            params: { api_key: TMDB_KEY, query: text, language: "ja-JP" },
          });
          apiItems = res.data.results.map((p: any) => ({
            id: `person_${p.id}`, title: p.name, subtitle: p.known_for_department,
            imageUrl: p.profile_path ? `https://image.tmdb.org/t/p/w200${p.profile_path}` : undefined,
            category: "person" as CategoryId,
          }));
        }

        if (searchIdRef.current !== myId) return;
        if (resultsLockedRef.current) return; // ロック中は無視
        if (apiItems.length === 0) return;

        // SQLiteに保存（次回以降のローカル検索に使う）
        await upsertTitles(apiItems);
        if (searchIdRef.current !== myId) return;

        // 既存の候補リストに「画像だけ」静かに付与（リスト自体は差し替えない）
        // APIにしかない新アイテムは末尾に追加
        const imageMap = new Map<string, string>();
        apiItems.forEach((item) => { if (item.imageUrl) imageMap.set(item.id, item.imageUrl); });

        setResults((prev) => {
          if (searchIdRef.current !== myId) return prev;
          if (resultsLockedRef.current) return prev; // ロック中は無視
          const existingIds = new Set(prev.map((i) => i.id));
          // 既存アイテムに画像を付与
          const enriched = prev.map((item) =>
            imageMap.has(item.id) ? { ...item, imageUrl: imageMap.get(item.id) } : item
          );
          // APIにしかない新アイテムを末尾に追加（本・音楽・人物など）
          const newItems = apiItems.filter((i) => !existingIds.has(i.id));
          return [...enriched, ...newItems];
        });
      } catch {}
    }, 300);
  }, [activeTab, spotifyToken]);

  // ── リスト操作 ──
  const addToMyList = useCallback((item: ListItem) => {
    setMyList((prev) => prev.find((m) => m.id === item.id) ? prev : [item, ...prev]);
  }, []);

  const handleCandidateTap = useCallback(async (item: ListItem) => {
    // ロックをかけて以降のsetResultsを全部無効化
    resultsLockedRef.current = true;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    searchIdRef.current += 1;
    setResults([]);
    setQuery("");
    Keyboard.dismiss();

    let finalItem = item;
    if (!item.imageUrl && item.category === "video") {
      const isTV = item.id.startsWith("tv_");
      const nid  = item.id.replace(/^(movie|tv)_/, "");
      const detail = await fetchTMDBDetail(isTV ? "tv" : "movie", nid);
      finalItem = { ...item, ...detail } as ListItem;
    }
    addToMyList(finalItem);

    // 少し遅らせてロック解除（念のため次の検索まで持続）
    setTimeout(() => { resultsLockedRef.current = false; }, 800);
  }, [addToMyList]);

  const handleRowPress = async (item: ListItem) => {
    setDetailLoading(true);
    let detail: Partial<ItemDetail> = { cast: [] };
    if (item.category === "video") {
      const isTV = item.id.startsWith("tv_");
      const nid  = item.id.replace(/^(movie|tv)_/, "");
      detail = await fetchTMDBDetail(isTV ? "tv" : "movie", nid) as Partial<ItemDetail>;
    }
    setSelectedItem({ ...item, cast: [], ...detail } as ItemDetail);
    setDetailLoading(false);
  };

  const handleTabChange = (id: TabId) => {
    closeResults();
    setQuery("");
    setActiveTab(id);
  };

  // idの重複をレンダリング前に除去（Spotifyの同一曲がtop/recentで重複した場合の対策）
  const dedupedList = myList.filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i);
  const filteredList = activeTab === "all" ? dedupedList : dedupedList.filter((m) => m.category === activeTab as CategoryId);
  const overlayMaxHeight = keyboardHeight > 0 ? screenHeight - keyboardHeight - 130 : 420;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : "height"}>

        {/* 検索バー */}
        <View style={[styles.searchRow, { marginTop: insets.top + 12 }]}>
          <TextInput
            ref={inputRef}
            style={styles.input}
            placeholder={activeTab === "all" ? "すべてのカテゴリを検索..." : `${TABS.find((t) => t.id === activeTab)?.label}を検索...`}
            placeholderTextColor="#555"
            value={query}
            onChangeText={handleSearch}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {query.length > 0 && (
            <TouchableOpacity
              style={styles.clearBtn}
              onPress={() => { closeResults(); setQuery(""); inputRef.current?.focus(); }}
            >
              <Text style={styles.clearBtnText}>✕</Text>
            </TouchableOpacity>
          )}
          {(!cacheReady || detailLoading) && <ActivityIndicator color="#fff" style={{ marginLeft: 6 }} />}
        </View>

        {/* 候補ウィンドウ外タップで閉じる */}
        {results.length > 0 && (
          <TouchableOpacity style={styles.dismissLayer} activeOpacity={1} onPress={() => { closeResults(); setQuery(""); Keyboard.dismiss(); }} />
        )}

        {/* 検索候補 */}
        {results.length > 0 && (
          <View style={[styles.searchOverlay, { maxHeight: overlayMaxHeight }]}>
            <FlatList
              data={results}
              keyExtractor={(item) => item.id}
              removeClippedSubviews
              maxToRenderPerBatch={12}
              keyboardShouldPersistTaps="handled"
              onScrollBeginDrag={() => Keyboard.dismiss()}
              renderItem={({ item }) => (
                <TouchableOpacity onPress={() => handleCandidateTap(item)} style={styles.card} activeOpacity={0.6}>
                  {item.imageUrl
                    ? <Image source={{ uri: item.imageUrl }} style={styles.cardThumb} />
                    : <View style={[styles.cardThumb, styles.noImage]}><Text style={{ fontSize: 16 }}>{CATEGORY_LABELS[item.category]?.slice(0, 1)}</Text></View>
                  }
                  <View style={styles.cardText}>
                    <View style={styles.cardTitleRow}>
                      <Text style={styles.cardTitle} numberOfLines={1}>{item.title}</Text>
                      {item.isSeries && (
                        <View style={styles.seriesBadge}>
                          <Text style={styles.seriesBadgeTxt}>シリーズ</Text>
                        </View>
                      )}
                      {activeTab === "all" && !item.isSeries && (
                        <Text style={styles.cardCatBadge}>{CATEGORY_LABELS[item.category]}</Text>
                      )}
                    </View>
                    {item.subtitle && <Text style={styles.cardSubtitle} numberOfLines={1}>{item.subtitle}</Text>}
                  </View>
                </TouchableOpacity>
              )}
            />
          </View>
        )}

        {/* マイリスト */}
        <SwipeListView
          data={filteredList}
          onScrollBeginDrag={() => { closeResults(); Keyboard.dismiss(); }}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.rowFront} onPress={() => handleRowPress(item)} activeOpacity={0.7}>
              {item.imageUrl
                ? <Image source={{ uri: item.imageUrl }} style={styles.thumbnail} />
                : <View style={[styles.thumbnail, styles.noImage]}><Text style={styles.noImageEmoji}>{CATEGORY_LABELS[item.category]?.slice(0, 1)}</Text></View>
              }
              <View style={styles.rowText}>
                <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
                <View style={styles.rowMeta}>
                  {activeTab === "all" && <Text style={styles.rowCatBadge}>{CATEGORY_LABELS[item.category]}</Text>}
                  {item.subtitle && <Text style={styles.rowSubtitle} numberOfLines={1}>{item.subtitle}</Text>}
                </View>
              </View>
            </TouchableOpacity>
          )}
          renderHiddenItem={(data) => (
            <TouchableOpacity style={styles.rowBack} onPress={() => setMyList(myList.filter((m) => m.id !== data.item.id))}>
              <Text style={styles.deleteText}>削除</Text>
            </TouchableOpacity>
          )}
          rightOpenValue={-80}
          ListEmptyComponent={<View style={styles.emptyState}><Text style={styles.emptyText}>まだ追加していません</Text></View>}
        />

        {/* 下部タブ（キーボード非表示時のみ） */}
        {!keyboardVisible && (
          <View style={styles.tabBarWrapper}>
            {activeTab === "music" && (
              spotifyToken
                ? <Text style={styles.spotifyConnectedText}>✅ Spotify 連携済み</Text>
                : <TouchableOpacity style={styles.spotifyBtn} onPress={openSpotifyAuth}>
                    <Text style={styles.spotifyBtnText}>Spotifyと連携する</Text>
                  </TouchableOpacity>
            )}
            <View style={styles.tabBar}>
              {TABS.map((tab) => (
                <TouchableOpacity key={tab.id} style={[styles.tabZone, activeTab === tab.id && styles.tabZoneActive]} onPress={() => handleTabChange(tab.id)}>
                  <Text style={[styles.tabText, activeTab === tab.id && styles.tabTextActive]}>{tab.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        <DetailModal
          initialItem={selectedItem}
          onClose={() => setSelectedItem(null)}
          onAddToList={addToMyList}
          alreadyAdded={(id) => !!myList.find((m) => m.id === id)}
        />

        {!keyboardVisible && (
          <TouchableOpacity style={[styles.fab, { bottom: 82 + insets.bottom }]} onPress={() => inputRef.current?.focus()}>
            <Text style={styles.fabText}>＋</Text>
          </TouchableOpacity>
        )}

      </KeyboardAvoidingView>
    </GestureHandlerRootView>
  );
}

// ─── スタイル ─────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },

  searchRow:  { flexDirection: "row", alignItems: "center", marginHorizontal: 12, marginBottom: 4, zIndex: 10 },
  input:      { flex: 1, height: 48, backgroundColor: "#1a1a1a", borderRadius: 24, paddingHorizontal: 20, color: "#fff", fontSize: 15, borderWidth: 1, borderColor: "#333" },
  clearBtn:      { width: 32, height: 32, borderRadius: 16, backgroundColor: "#2a2a2a", justifyContent: "center", alignItems: "center", marginLeft: 8 },
  clearBtnText:  { color: "#888", fontSize: 13 },

  dismissLayer:  { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 8 },
  searchOverlay: { marginHorizontal: 12, backgroundColor: "#111", borderRadius: 12, borderWidth: 1, borderColor: "#222", zIndex: 9 },

  card:         { flexDirection: "row", alignItems: "center", padding: 12, borderBottomWidth: 1, borderBottomColor: "#1e1e1e" },
  cardThumb:    { width: 40, height: 56, borderRadius: 4 },
  cardText:     { flex: 1, marginLeft: 12 },
  cardTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  cardTitle:    { color: "#fff", fontSize: 14, fontWeight: "600", flex: 1 },
  cardCatBadge: { color: "#888", fontSize: 11, borderWidth: 1, borderColor: "#333", borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  cardSubtitle: { color: "#666", fontSize: 12, marginTop: 2 },
  seriesBadge:    { backgroundColor: "#1a1a3a", borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, borderWidth: 1, borderColor: "#333" },
  seriesBadgeTxt: { color: "#7eb8ff", fontSize: 10, fontWeight: "700" },

  rowFront:    { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 10, backgroundColor: "#000", borderBottomWidth: 1, borderBottomColor: "#111" },
  rowBack:     { alignItems: "flex-end", justifyContent: "center", flex: 1, backgroundColor: "#ff3b30", paddingRight: 24 },
  deleteText:  { color: "#fff", fontWeight: "700", fontSize: 14 },
  rowText:     { flex: 1, marginLeft: 12 },
  rowMeta:     { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  rowTitle:    { color: "#fff", fontSize: 15, fontWeight: "600" },
  rowSubtitle: { color: "#666", fontSize: 12 },
  rowCatBadge: { color: "#555", fontSize: 11, borderWidth: 1, borderColor: "#333", borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  thumbnail:    { width: 44, height: 64, borderRadius: 4 },
  noImage:      { backgroundColor: "#1a1a1a", justifyContent: "center", alignItems: "center" },
  noImageEmoji: { fontSize: 18 },

  emptyState: { paddingVertical: 60, alignItems: "center" },
  emptyText:  { color: "#444", fontSize: 14 },

  tabBarWrapper: { borderTopWidth: 0.5, borderTopColor: "#222" },
  tabBar:        { flexDirection: "row", height: 68 },
  tabZone:       { flex: 1, justifyContent: "center", alignItems: "center", paddingVertical: 8 },
  tabZoneActive: { borderTopWidth: 2, borderTopColor: "#fff" },
  tabText:       { color: "#555", fontSize: 13, fontWeight: "600" },
  tabTextActive: { color: "#fff" },

  spotifyBtn:           { marginHorizontal: 12, marginTop: 8, backgroundColor: "#1DB954", borderRadius: 25, paddingVertical: 10, alignItems: "center" },
  spotifyBtnText:       { color: "#fff", fontWeight: "700", fontSize: 14 },
  spotifyConnectedText: { color: "#1DB954", fontSize: 12, textAlign: "center", paddingVertical: 6 },

  fab:     { position: "absolute", right: 24, width: 52, height: 52, borderRadius: 26, backgroundColor: "#fff", justifyContent: "center", alignItems: "center", zIndex: 5, shadowColor: "#fff", shadowOpacity: 0.3, shadowRadius: 10, elevation: 8 },
  fabText: { fontSize: 26, color: "#000", lineHeight: 30 },

  modalBg:             { flex: 1, backgroundColor: "rgba(0,0,0,0.97)" },
  modalScroll:         { flex: 1 },
  modalScrollContent:  { alignItems: "center", paddingBottom: 100, paddingHorizontal: 20 },
  modalLoadingOverlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, justifyContent: "center", alignItems: "center", zIndex: 20 },
  modalImage:   { width: 220, height: 330, borderRadius: 10 },
  modalNoImage: { width: 220, height: 330, borderRadius: 10, backgroundColor: "#1a1a1a", justifyContent: "center", alignItems: "center" },
  modalTitle:   { color: "#fff", fontSize: 22, fontWeight: "700", marginTop: 18, textAlign: "center" },
  modalYear:    { color: "#888", fontSize: 14, marginTop: 4 },
  addBtn:       { marginTop: 16, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 22, borderWidth: 1.5, borderColor: "#fff" },
  addBtnDone:   { borderColor: "#444" },
  addBtnText:   { color: "#fff", fontSize: 14, fontWeight: "600" },
  metaRow:      { flexDirection: "row", marginTop: 14, alignSelf: "flex-start" },
  metaLabel:    { color: "#888", fontSize: 13, width: 48 },
  metaValue:    { color: "#ccc", fontSize: 13, flex: 1 },
  metaLink:     { color: "#7eb8ff", textDecorationLine: "underline" },
  overview:     { color: "#aaa", fontSize: 13, lineHeight: 20, marginTop: 14, alignSelf: "flex-start" },
  castSection:  { alignSelf: "stretch", marginTop: 20 },
  castLabel:    { color: "#888", fontSize: 13, marginBottom: 10 },
  castList:     { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  castChip:     { flexDirection: "row", alignItems: "center", backgroundColor: "#1a1a1a", borderRadius: 20, paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, borderColor: "#2a2a2a" },
  castAvatar:   { width: 28, height: 28, borderRadius: 14, marginRight: 6 },
  castName:     { color: "#fff", fontSize: 13, fontWeight: "600" },
  castChar:     { color: "#666", fontSize: 11, maxWidth: 100 },
  modalBottomBtns:    { position: "absolute", left: 20, flexDirection: "row", gap: 10 },
  modalBottomBtn:     { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 24, backgroundColor: "rgba(255,255,255,0.25)", borderWidth: 1, borderColor: "rgba(255,255,255,0.4)" },
  modalBottomBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  filmoContainer:     { flex: 1, paddingHorizontal: 16 },
  filmoPersonName:    { color: "#fff", fontSize: 20, fontWeight: "700", marginBottom: 12 },
  filmoTabRow:        { flexDirection: "row", gap: 8, marginBottom: 16 },
  filmoTab:           { paddingHorizontal: 16, paddingVertical: 7, borderRadius: 16, backgroundColor: "#1a1a1a", borderWidth: 1, borderColor: "#333" },
  filmoTabActive:     { backgroundColor: "#fff", borderColor: "#fff" },
  filmoTabText:       { color: "#888", fontSize: 13, fontWeight: "600" },
  filmoTabTextActive: { color: "#000" },
  filmoRow:           { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#1a1a1a" },
  filmoThumb:         { width: 46, height: 68, borderRadius: 4 },
  filmoText:          { flex: 1, marginLeft: 12 },
  filmoName:          { color: "#fff", fontSize: 14, fontWeight: "600" },
  filmoSub:           { color: "#666", fontSize: 12, marginTop: 2 },
  filmoArrow:         { color: "#444", fontSize: 20, paddingLeft: 8 },
});
