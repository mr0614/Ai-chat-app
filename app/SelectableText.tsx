/**
 * SelectableText.tsx
 * タップで単語選択、ドラッグで範囲選択、ドラッグ中はハイライト表示。
 * 使い方: <SelectableText text="..." style={...} />
 */

import React, { useCallback, useRef, useState } from "react";
import {
  GestureResponderEvent,
  StyleProp,
  StyleSheet,
  Text,
  TextStyle,
  View,
} from "react-native";

interface Props {
  text: string;
  style?: StyleProp<TextStyle>;
  highlightColor?: string;
}

// テキストをトークン（単語・空白・句読点）に分割
function tokenize(text: string): string[] {
  return text.split(/(\s+|[、。！？,.!?\n])/g).filter((t) => t.length > 0);
}

export default function SelectableText({ text, style, highlightColor = "#2a5080" }: Props) {
  const tokens = tokenize(text);
  const [selectedRange, setSelectedRange] = useState<{ start: number; end: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<number>(-1);
  const tokenRefs = useRef<{ x: number; y: number; width: number; height: number; index: number }[]>([]);
  const containerRef = useRef<View>(null);
  const containerLayout = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const getTokenIndexAtPoint = useCallback((px: number, py: number): number => {
    // コンテナ相対座標に変換
    const rx = px - containerLayout.current.x;
    const ry = py - containerLayout.current.y;
    let closest = -1;
    let minDist = Infinity;
    for (const t of tokenRefs.current) {
      if (rx >= t.x && rx <= t.x + t.width && ry >= t.y && ry <= t.y + t.height) {
        return t.index;
      }
      // 最近傍フォールバック
      const cx = t.x + t.width / 2;
      const cy = t.y + t.height / 2;
      const d = Math.abs(rx - cx) + Math.abs(ry - cy);
      if (d < minDist) { minDist = d; closest = t.index; }
    }
    return closest;
  }, []);

  const onContainerLayout = () => {
    containerRef.current?.measureInWindow((x, y) => {
      containerLayout.current = { x, y };
    });
  };

  const onTouchStart = useCallback((e: GestureResponderEvent) => {
    const idx = getTokenIndexAtPoint(e.nativeEvent.pageX, e.nativeEvent.pageY);
    if (idx < 0) return;
    dragStart.current = idx;
    setDragging(true);
    setSelectedRange({ start: idx, end: idx });
  }, [getTokenIndexAtPoint]);

  const onTouchMove = useCallback((e: GestureResponderEvent) => {
    if (!dragging || dragStart.current < 0) return;
    const idx = getTokenIndexAtPoint(e.nativeEvent.pageX, e.nativeEvent.pageY);
    if (idx < 0) return;
    const s = Math.min(dragStart.current, idx);
    const en = Math.max(dragStart.current, idx);
    setSelectedRange({ start: s, end: en });
  }, [dragging, getTokenIndexAtPoint]);

  const onTouchEnd = useCallback(() => {
    setDragging(false);
  }, []);

  const isSelected = (i: number) =>
    selectedRange !== null && i >= selectedRange.start && i <= selectedRange.end;

  return (
    <View
      ref={containerRef}
      onLayout={onContainerLayout}
      onStartShouldSetResponder={() => true}
      onResponderGrant={onTouchStart}
      onResponderMove={onTouchMove}
      onResponderRelease={onTouchEnd}
      style={styles.container}
    >
      <Text style={[styles.text, style]}>
        {tokens.map((token, i) => (
          <Text
            key={i}
            style={isSelected(i) ? [styles.text, style, { backgroundColor: highlightColor, color: "#fff" }] : [styles.text, style]}
            onLayout={(e) => {
              // 各トークンの位置をコンテナ相対で記録
              // TextのonLayoutはコンテナ相対なので直接使える
              const { x, y, width, height } = e.nativeEvent.layout;
              tokenRefs.current[i] = { x, y, width, height, index: i };
            }}
          >
            {token}
          </Text>
        ))}
      </Text>
      {selectedRange !== null && (
        <Text style={styles.selectedHint} selectable>
          {tokens.slice(selectedRange.start, selectedRange.end + 1).join("")}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container:    { },
  text:         { color: "#e0e0e0", fontSize: 14, lineHeight: 22 },
  selectedHint: { display: "none" }, // 選択テキストをコピー可能にするための非表示要素
});
