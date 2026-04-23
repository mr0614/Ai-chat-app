import React, { useEffect } from 'react';
import { Keyboard, StyleSheet, TextInput } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

export default function SyncInput() {
  const keyboardHeight = useSharedValue(0);

  useEffect(() => {
    const showSubscription = Keyboard.addListener('keyboardWillShow', (e) => {
      keyboardHeight.value = withTiming(e.endCoordinates.height, { duration: 250 });
    });
    const hideSubscription = Keyboard.addListener('keyboardWillHide', () => {
      keyboardHeight.value = withTiming(0, { duration: 250 });
    });
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    marginBottom: keyboardHeight.value,
  }));

  return (
    <Animated.View style={[styles.container, animatedStyle]}>
      <TextInput style={styles.input} placeholder="ここに入力" />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 20 },
  input: { height: 50, backgroundColor: '#333', color: '#fff', borderRadius: 25, paddingHorizontal: 20 }
});