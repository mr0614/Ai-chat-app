// app/_layout.tsx
import { Ionicons } from '@expo/vector-icons';
import { Slot, usePathname, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { chatEngine, CHAT_STATE_KEY } from './chatEngine';
import AsyncStorage from '@react-native-async-storage/async-storage';

const TABS = [
  { path: '/',         icon: 'home'               as const },
  { path: '/myworld',  icon: 'library'            as const },
  { path: '/ai',       icon: 'chatbubble-ellipses' as const },
  { path: '/settings', icon: 'settings'           as const },
];

export default function RootLayout() {
  const router   = useRouter();
  const pathname = usePathname();
  const insets   = useSafeAreaInsets();
  const [chatLoading,  setChatLoading]  = useState(false);
  const [chatWaiting,  setChatWaiting]  = useState("");
  const [hoveredPath,  setHoveredPath]  = useState<string | null>(null);
  const tabLayouts = useRef<{ path: string; x: number; width: number }[]>([]);
  const navBarX    = useRef(0);

  // chatEngineの状態をポーリングして表示
  useEffect(() => {
    const unsub = chatEngine.subscribe(async () => {
      const s = await chatEngine.getState();
      setChatLoading(s.loading);
    });
    const unsubWaiting = chatEngine.subscribeWaiting((msg) => {
      setChatWaiting(msg);
    });
    return () => { unsub(); unsubWaiting(); };
  }, []);

  const getPathAtX = (px: number) => {
    const rx = px - navBarX.current;
    return tabLayouts.current.find((t) => rx >= t.x && rx <= t.x + t.width)?.path ?? null;
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Slot />
      </View>

      {/* 会話生成中インジケーター（他タブにいる時も表示） */}
      {chatLoading && pathname !== '/ai' && (
        <View style={styles.chatIndicator}>
          <Text style={styles.chatIndicatorText}>
            {chatWaiting || '● 会話生成中...'}
          </Text>
          <Text style={styles.chatIndicatorLink} onPress={() => router.push('/ai')}>
            確認する
          </Text>
        </View>
      )}

      <View
        style={[styles.navBar, { paddingBottom: insets.bottom + 8 }]}
        onLayout={(e) => { navBarX.current = e.nativeEvent.layout.x; }}
        onStartShouldSetResponder={() => true}
        onResponderGrant={(e) => {
          const path = getPathAtX(e.nativeEvent.pageX);
          if (path) setHoveredPath(path);
        }}
        onResponderMove={(e) => {
          const path = getPathAtX(e.nativeEvent.pageX);
          setHoveredPath(path);
        }}
        onResponderRelease={(e) => {
          const path = getPathAtX(e.nativeEvent.pageX);
          if (path) router.push(path as any);
          setHoveredPath(null);
        }}
        onResponderTerminate={() => setHoveredPath(null)}
      >
        {TABS.map((tab, i) => {
          const isActive  = pathname === tab.path;
          const isHovered = hoveredPath === tab.path;
          const color = isActive ? '#fff' : isHovered ? '#aaa' : '#555';
          const showDot = tab.path === '/ai' && chatLoading && !isActive;
          return (
            <View
              key={tab.path}
              style={[styles.tabZone, isHovered && styles.tabZoneHovered]}
              onLayout={(e) => {
                tabLayouts.current[i] = {
                  path: tab.path,
                  x: e.nativeEvent.layout.x,
                  width: e.nativeEvent.layout.width,
                };
              }}
            >
              <Ionicons name={tab.icon} size={24} color={color} />
              {showDot && <View style={styles.dot} />}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  content:   { flex: 1 },
  navBar: {
    flexDirection: 'row', backgroundColor: '#000',
    borderTopWidth: 0.5, borderTopColor: '#333', paddingTop: 12,
  },
  tabZone:        { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 8 },
  tabZoneHovered: { backgroundColor: '#1a1a1a', borderRadius: 12 },
  dot: { position: 'absolute', top: 4, right: 12, width: 6, height: 6, borderRadius: 3, backgroundColor: '#7eb8ff' },
  chatIndicator: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: '#060e1a', paddingHorizontal: 16, paddingVertical: 8,
    borderTopWidth: 0.5, borderTopColor: '#1a3a6a',
  },
  chatIndicatorText: { color: '#7eb8ff', fontSize: 12 },
  chatIndicatorLink: { color: '#3a6ea8', fontSize: 12, fontWeight: '600' },
});
