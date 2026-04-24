/**
 * index.tsx — ホーム画面
 *
 * - 入力バーは常に下部固定
 * - キーボードの確定で追加、入力バーをクリア
 * - 上部にリスト化（スワイプで削除）
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useEffect, useRef, useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SwipeListView } from "react-native-swipe-list-view";
import { useSafeAreaInsets } from "react-native-safe-area-context";

interface Entry {
  id:        string;
  text:      string;
  createdAt: number;
}

const STORAGE_KEY = "home_entries";

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const [entries,   setEntries]   = useState<Entry[]>([]);
  const [inputText, setInputText] = useState("");
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((json) => {
      if (json) { try { setEntries(JSON.parse(json)); } catch {} }
    });
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  }, [entries]);

  const handleSubmit = () => {
    const text = inputText.trim();
    if (!text) return;
    setEntries((prev) => [
      { id: Date.now().toString(), text, createdAt: Date.now() },
      ...prev,
    ]);
    setInputText("");
  };

  const deleteEntry = (id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      {entries.length > 0 ? (
        <SwipeListView
          data={entries}
          keyExtractor={(item) => item.id}
          style={styles.list}
          contentContainerStyle={[styles.listContent, { paddingTop: insets.top + 16 }]}
          onScrollBeginDrag={() => Keyboard.dismiss()}
          renderItem={({ item, index }) => (
            <View style={[styles.entryCard, index === 0 && styles.entryCardFirst]}>
              <Text style={styles.entryText}>{item.text}</Text>
            </View>
          )}
          renderHiddenItem={({ item }) => (
            <TouchableOpacity style={styles.deleteBtn} onPress={() => deleteEntry(item.id)}>
              <Text style={styles.deleteBtnText}>削除</Text>
            </TouchableOpacity>
          )}
          rightOpenValue={-80}
          disableRightSwipe
        />
      ) : (
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>あなた自身について{"\n"}教えてください</Text>
        </View>
      )}

      {/* 常に下部固定の入力バー */}
      <View style={[styles.inputWrapper, { paddingBottom: insets.bottom + 8 }]}>
        <TextInput
          ref={inputRef}
          style={styles.input}
          placeholder="あなたについて教えて"
          placeholderTextColor="#555"
          value={inputText}
          onChangeText={setInputText}
          returnKeyType="done"
          onSubmitEditing={handleSubmit}
          blurOnSubmit={false}
          autoCorrect={false}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },

  list:        { flex: 1 },
  listContent: { paddingHorizontal: 16, paddingBottom: 20 },

  entryCard: {
    borderWidth: 1, borderColor: "#333", borderRadius: 12,
    padding: 16, marginBottom: 10, backgroundColor: "#0a0a0a",
  },
  entryCardFirst: { borderColor: "#555" },
  entryText:      { color: "#fff", fontSize: 15, lineHeight: 22 },

  deleteBtn: {
    alignItems: "flex-end", justifyContent: "center", flex: 1,
    backgroundColor: "#ff3b30", paddingRight: 24,
    marginBottom: 10, borderRadius: 12,
  },
  deleteBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },

  emptyState: { flex: 1, justifyContent: "center", alignItems: "center" },
  emptyText:  { color: "#333", fontSize: 18, textAlign: "center", lineHeight: 28 },

  inputWrapper: {
    borderTopWidth: 0.5, borderTopColor: "#222",
    paddingHorizontal: 16, paddingTop: 10, backgroundColor: "#000",
  },
  input: {
    height: 48, backgroundColor: "#1a1a1a", borderRadius: 24,
    paddingHorizontal: 20, color: "#fff", fontSize: 15,
    borderWidth: 1, borderColor: "#333",
  },
});
