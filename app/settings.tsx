// app/settings.tsx
import { StyleSheet, View } from 'react-native';

export default function SettingsScreen() {
  return <View style={styles.container} />; // 中身を空にするだけで文字は消えます
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' }
});