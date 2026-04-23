import axios from 'axios';
import React, { useState } from 'react';
import { FlatList, Image, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';

export default function MyWorldScreen() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const API_KEY = 'ceee639ddddbbae4dbb66e91ff456026'; // ここにさっき成功したキーを入れてください

  const searchMovies = async (text: string) => {
    setQuery(text);
    if (text.length > 2) {
      try {
        const res = await axios.get(`https://api.themoviedb.org/3/search/movie`, {
          params: { api_key: API_KEY, query: text, language: 'ja-JP' }
        });
        setResults(res.data.results);
      } catch (e) { console.log("検索エラー", e); }
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.container}>
      <FlatList
        data={results}
        keyExtractor={(item: any) => item.id.toString()}
        renderItem={({ item }) => (
          <View style={styles.card}>
            {item.poster_path && <Image source={{uri: `https://image.tmdb.org/t/p/w200${item.poster_path}`}} style={styles.image}/>}
            <Text style={{color: '#fff', flex: 1}}>{item.title}</Text>
          </View>
        )}
      />
      <View style={styles.inputArea}>
        <TextInput 
          style={styles.input} 
          placeholder="作品名を入力..." 
          placeholderTextColor="#666"
          value={query}
          onChangeText={searchMovies}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  card: { flexDirection: 'row', padding: 10, alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#333' },
  image: { width: 50, height: 75, marginRight: 15 },
  inputArea: { padding: 10, backgroundColor: '#000' },
  input: { height: 50, backgroundColor: '#1a1a1a', borderRadius: 25, paddingHorizontal: 20, color: '#fff' }
});