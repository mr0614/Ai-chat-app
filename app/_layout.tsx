// app/_layout.tsx
import { Ionicons } from '@expo/vector-icons';
import { Slot, useRouter } from 'expo-router';
import { StyleSheet, TouchableOpacity, View } from 'react-native';

export default function RootLayout() {
  const router = useRouter();

  return (
    <View style={styles.container}>
      <View style={styles.content}><Slot /></View>
      <View style={styles.navBar}>
        <TouchableOpacity onPress={() => router.push('/')}><Ionicons name="home" size={24} color="#fff" /></TouchableOpacity>
        <TouchableOpacity onPress={() => router.push('/myworld')}><Ionicons name="library" size={24} color="#fff" /></TouchableOpacity>
        <TouchableOpacity onPress={() => router.push('/settings')}><Ionicons name="settings" size={24} color="#fff" /></TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  content: { flex: 1, paddingTop: 40 }, // ここでカメラとの被りを調整
  navBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 25,
    backgroundColor: '#000',
    borderTopWidth: 0.5,
    borderTopColor: '#333'
  }
});