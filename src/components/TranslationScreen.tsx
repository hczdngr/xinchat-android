
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { useRoute, type RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../navigation/types';

import { API_BASE } from '../config';

// Call the real backend API
const callGeminiApi = async (text: string): Promise<{ translated: string; explanation: string }> => {
  console.log(`[API] Translating: "${text}"`);
  
  const response = await fetch(`${API_BASE}/api/translate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ message: 'Unknown error' }));
    throw new Error(`API request failed with status ${response.status}: ${errorBody.message}`);
  }

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.message || 'API returned a failure response.');
  }

  return {
    translated: result.translated || '',
    explanation: result.explanation || '',
  };
};

type TranslationScreenRouteProp = RouteProp<RootStackParamList, 'Translation'>;

export default function TranslationScreen() {
  const route = useRoute<TranslationScreenRouteProp>();
  const { textToTranslate } = route.params;

  const [isLoading, setIsLoading] = useState(true);
  const [translationResult, setTranslationResult] = useState<{ translated: string; explanation: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    const translateText = async () => {
      try {
        setIsLoading(true);
        const result = await callGeminiApi(textToTranslate);
        if (isMounted) {
          setTranslationResult(result);
          setError(null);
        }
      } catch (e) {
        if (isMounted) {
          setError('翻译失败，请稍后重试。');
          console.error(e);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    translateText();

    return () => {
      isMounted = false;
    };
  }, [textToTranslate]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <View style={styles.section}>
        <Text style={styles.title}>原文</Text>
        <View style={styles.card}>
          <Text style={styles.text}>{textToTranslate}</Text>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.title}>翻译结果 (简体中文)</Text>
        <View style={styles.card}>
          {isLoading ? (
            <ActivityIndicator size="large" color="#007AFF" style={styles.loader} />
          ) : error ? (
            <Text style={styles.errorText}>{error}</Text>
          ) : (
            <Text style={styles.text}>{translationResult?.translated}</Text>
          )}
        </View>
      </View>

      {!isLoading && !error && translationResult?.explanation && (
        <View style={styles.section}>
          <Text style={styles.title}>Gemini 的解释</Text>
          <View style={styles.card}>
            <Text style={styles.explanationText}>{translationResult.explanation}</Text>
          </View>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F0F2F5',
  },
  contentContainer: {
    padding: 16,
  },
  section: {
    marginBottom: 24,
  },
  title: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 8,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  text: {
    fontSize: 16,
    lineHeight: 24,
    color: '#333',
  },
  explanationText: {
    fontSize: 14,
    lineHeight: 22,
    color: '#555',
  },
  loader: {
    marginVertical: 20,
  },
  errorText: {
    fontSize: 16,
    color: 'red',
    textAlign: 'center',
  },
});
