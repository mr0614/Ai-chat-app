// app/_layout.tsx
import { Ionicons } from '@expo/vector-icons';
import { Slot, usePathname, useRouter } from 'expo-router';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const TABS = [
  { path: '/',         icon: 'home'              as const },
  { path: '/myworld',  icon: 'library'           as const },
  { path: '/ai',       icon: 'chatbubble-ellipses' as const },
  { path: '/settings', icon: 'settings'          as const },
];

export default function RootLayout() {
  const router   = useRouter();
  const pathname = usePathname();
  const insets   = useSafeAreaInsets();

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Slot />
      </View>

      <View style={[styles.navBar, { paddingBottom: insets.bottom + 8 }]}>
        {TABS.map((tab) => {
          const isActive = pathname === tab.path;
          return (
            <TouchableOpacity
              key={tab.path}
              style={styles.tabZone}
              onPress={() => router.push(tab.path)}
              activeOpacity={0.6}
            >
              <Ionicons
                name={tab.icon}
                size={24}
                color={isActive ? '#fff' : '#555'}
              />
            </TouchableOpacity>
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
    flexDirection:   'row',
    backgroundColor: '#000',
    borderTopWidth:  0.5,
    borderTopColor:  '#333',
    paddingTop:      12,
  },

  tabZone: {
    flex:            1,
    alignItems:      'center',
    justifyContent:  'center',
    paddingVertical: 8,
  },
});

