import { useRef, useState } from 'react';
import { Button, FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { GestureHandlerRootView, Swipeable } from 'react-native-gesture-handler';

export default function HomeScreen() {
  const [text, setText] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const swipeableRefs = useRef<any[]>([]);
  const flatListRef = useRef<FlatList>(null); // リストのスクロール操作用

  const handleSend = () => {
    if (text.trim() === '') return;
    setHistory([...history, text]);
    setText('');
  };

  const deleteItem = (index: number) => {
    if (swipeableRefs.current[index]) {
      swipeableRefs.current[index].close();
    }
    setHistory(history.filter((_, i) => i !== index));
  };

  const renderRightActions = (index: number) => (
    <TouchableOpacity style={styles.deleteButton} onPress={() => deleteItem(index)}>
      <Text style={styles.deleteText}>削除</Text>
    </TouchableOpacity>
  );

  return (
    <GestureHandlerRootView style={styles.fullScreen}>
      <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'} 
        style={styles.fullScreen}
        // キーボード表示時のオフセットを調整
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >
        <View style={styles.container}>
          {/* 自動スクロールの設定 */}
          <FlatList
            ref={flatListRef}
            data={history}
            // --- ここを追加 ---
            keyboardShouldPersistTaps="handled" 
            // ------------------
            keyExtractor={(item, index) => index.toString()}
            renderItem={({ item, index }) => (
              <Swipeable 
                ref={(ref) => (swipeableRefs.current[index] = ref)}
                renderRightActions={() => renderRightActions(index)}
              >
                <View style={styles.itemBox}>
                  <Text style={styles.itemText}>{item}</Text>
                </View>
              </Swipeable>
            )}
            onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
          />

          <View style={styles.inputArea}>
            <TouchableOpacity onPress={() => alert('戻る')} style={styles.backButton}>
              <Text style={{color: '#fff'}}>←</Text>
            </TouchableOpacity>
            <TextInput
              style={styles.input}
              placeholder="ここに入力..."
              placeholderTextColor="#888"
              value={text}
              onChangeText={setText}
            />
            <Button title="追加" onPress={handleSend} color="#fff" />
          </View>
        </View>
      </KeyboardAvoidingView>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  fullScreen: { flex: 1, backgroundColor: '#000' },
  container: { flex: 1, padding: 20 },
  listContent: { paddingTop: 10, paddingBottom: 20 },
  inputArea: { 
    backgroundColor: '#000', 
    borderWidth: 1, 
    borderColor: '#444',     // 少し暗い枠線
    borderRadius: 12, 
    padding: 2,              // 余白を狭く
    flexDirection: 'row', 
    alignItems: 'center' 
  },
  backButton: { padding: 8 }, // 余白を少し狭く
  input: { flex: 1, height: 35, paddingHorizontal: 8, color: '#fff' }, // 高さも少しコンパクトに
  itemBox: { 
    backgroundColor: 'transparent', 
    borderWidth: 1, 
    borderColor: '#444',    // 少し暗い枠線
    borderRadius: 12, 
    padding: 10,            // 余白を狭く
    marginVertical: 4 
  },
  itemText: { color: '#fff', fontSize: 16 },
  deleteButton: { 
    backgroundColor: 'red', 
    justifyContent: 'center', 
    alignItems: 'center', 
    width: 80, 
    borderRadius: 12, 
    marginVertical: 4 
  },
  deleteText: { color: '#fff', fontWeight: 'bold' }
});