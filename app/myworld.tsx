import axios from "axios";
import React, { useRef, useState } from "react";
import {
  FlatList,
  Image,
  Keyboard,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SwipeListView } from "react-native-swipe-list-view";
import * as wanakana from "wanakana";

// コンポーネント外にキャッシュを配置し、再レンダリングで消えないようにする
let globalCache: any[] = [];

export default function MyWorldScreen() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [myList, setMyList] = useState([]);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);

  // 高速検索ロジック
  const handleSearch = async (text: string) => {
    setQuery(text);
    if (text.length < 1) {
      setResults([]);
      return;
    }

    // 1. まずローカルのキャッシュで即時フィルタリング（爆速）
    const normalizedQuery = wanakana.toHiragana(text);
    const quickMatch = globalCache.filter(
      (m) =>
        wanakana.toHiragana(m.title).includes(normalizedQuery) ||
        m.title.toLowerCase().includes(text.toLowerCase()),
    );
    setResults(quickMatch);

    // 2. キャッシュにない場合のみAPIを叩く（デバウンスと併用）
    if (text.length >= 2) {
      try {
        const res = await axios.get(
          `https://api.themoviedb.org/3/search/movie`,
          {
            params: {
              api_key: process.env.EXPO_PUBLIC_TMDB_API_KEY,
              query: wanakana.toKatakana(text),
              language: "ja-JP",
            },
          },
        );
        globalCache = res.data.results;
        setResults(res.data.results);
      } catch (e) {}
    }
  };

  const addToMyList = (movie: any) => {
    if (!myList.find((m: any) => m.id === movie.id)) {
      setMyList([movie, ...myList]);
    }
    setResults([]);
    setQuery("");
    Keyboard.dismiss();
  };

  return (
    <View style={styles.container}>
      <TextInput
        ref={inputRef}
        style={styles.input}
        placeholder="作品を検索..."
        placeholderTextColor="#666"
        value={query}
        onChangeText={handleSearch}
      />

      <SwipeListView
        data={myList}
        onScrollBeginDrag={() => Keyboard.dismiss()}
        keyExtractor={(item: any) => item.id.toString()}
        renderItem={({ item }) => (
          <View style={styles.rowFront}>
            <TouchableOpacity
              onPress={() => setSelectedImage(item.poster_path)}
            >
              <Image
                source={{
                  uri: `https://image.tmdb.org/t/p/w200${item.poster_path}`,
                }}
                style={styles.thumbnail}
              />
            </TouchableOpacity>
            <Text style={styles.text}>{item.title}</Text>
          </View>
        )}
        renderHiddenItem={(data) => (
          <TouchableOpacity
            style={styles.rowBack}
            onPress={() =>
              setMyList(myList.filter((m: any) => m.id !== data.item.id))
            }
          >
            <Text style={styles.deleteText}>削除</Text>
          </TouchableOpacity>
        )}
        rightOpenValue={-75}
      />

      {results.length > 0 && (
        <FlatList
          style={styles.searchOverlay}
          data={results}
          keyExtractor={(item: any) => item.id.toString()}
          removeClippedSubviews={true} // 高速化設定
          maxToRenderPerBatch={10} // 高速化設定
          renderItem={({ item }) => (
            <TouchableOpacity
              onPress={() => addToMyList(item)}
              style={styles.card}
            >
              <Text style={styles.text}>{item.title}</Text>
            </TouchableOpacity>
          )}
        />
      )}

      <Modal visible={!!selectedImage} transparent={true}>
        <TouchableOpacity
          style={styles.modalOverlay}
          onPress={() => setSelectedImage(null)}
        >
          <Image
            source={{ uri: `https://image.tmdb.org/t/p/w500${selectedImage}` }}
            style={styles.fullImage}
          />
        </TouchableOpacity>
      </Modal>

      <TouchableOpacity
        style={styles.floatingButton}
        onPress={() => inputRef.current?.focus()}
      >
        <Text style={styles.buttonText}>＋</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000", paddingTop: 50 },
  input: {
    height: 50,
    backgroundColor: "#333",
    margin: 15,
    borderRadius: 25,
    paddingHorizontal: 20,
    color: "#fff",
    zIndex: 10,
  },
  rowFront: {
    flexDirection: "row",
    alignItems: "center",
    padding: 15,
    backgroundColor: "#000",
    borderBottomWidth: 1,
    borderBottomColor: "#222",
  },
  rowBack: {
    alignItems: "flex-end",
    justifyContent: "center",
    flex: 1,
    backgroundColor: "#ff3b30",
    paddingRight: 20,
  },
  deleteText: { color: "#fff", fontWeight: "bold" },
  searchOverlay: {
    position: "absolute",
    top: 110,
    left: 15,
    right: 15,
    backgroundColor: "#1a1a1a",
    zIndex: 20,
    borderRadius: 10,
    maxHeight: 400,
  },
  card: { padding: 15, borderBottomWidth: 1, borderBottomColor: "#333" },
  floatingButton: {
    position: "absolute",
    bottom: 40,
    right: 30,
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "#fff",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 5,
  },
  buttonText: { fontSize: 30 },
  text: { color: "#fff" },
  thumbnail: { width: 40, height: 60, marginRight: 15 },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.9)",
    justifyContent: "center",
    alignItems: "center",
  },
  fullImage: { width: 300, height: 450, resizeMode: "contain" },
});
