/**
 * 模块说明：翻译路由模块：处理翻译请求与模型响应规整。
 */


import express from 'express';
import { GoogleGenAI } from '@google/genai';
import { logger } from '../observability.js';

const router = express.Router();
const MAX_TRANSLATE_TEXT_LENGTH = 6000;
// isPlainObject：判断条件是否成立。
const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// toPlainObject?处理 toPlainObject 相关逻辑。
const toPlainObject = (value) => (isPlainObject(value) ? value : {});
// asyncRoute?处理 asyncRoute 相关逻辑。
const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

// Initialize Google Generative AI
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  logger.warn('GEMINI_API_KEY is not set. Translation API will not work.');
}
const genAI = apiKey ? new GoogleGenAI(apiKey) : null;
const model = genAI ? genAI.getGenerativeModel({ model: 'gemini-pro' }) : null;

// 路由：POST /。
router.post('/', asyncRoute(async (req, res) => {
  if (!model) {
    return res.status(503).json({
      success: false,
      message: 'Translation service is not configured on the server.',
    });
  }

  const payload = toPlainObject(req.body);
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text || text.length > MAX_TRANSLATE_TEXT_LENGTH) {
    return res.status(400).json({ success: false, message: 'Invalid input text.' });
  }

  try {
    const prompt = `Translate the following text to Simplified Chinese and provide a brief explanation for the translation. The text to translate is: "${text}". Structure your response as a JSON object with two keys: "translated" and "explanation". Do not include any other text or markdown formatting outside of the JSON object.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const responseText = response.text();

    // Clean the response to ensure it's valid JSON
    const cleanedText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();

    try {
      // Parse the JSON string from the model's response
      const jsonResponse = JSON.parse(cleanedText);
      if (!jsonResponse || typeof jsonResponse !== 'object' || Array.isArray(jsonResponse)) {
        throw new Error('MODEL_RESPONSE_NOT_OBJECT');
      }
      const translated =
        typeof jsonResponse.translated === 'string' ? jsonResponse.translated.trim() : '';
      const explanation =
        typeof jsonResponse.explanation === 'string' ? jsonResponse.explanation.trim() : '';
      if (!translated) {
        throw new Error('MODEL_RESPONSE_MISSING_TRANSLATED');
      }
      res.json({ success: true, translated, explanation });
    } catch (parseError) {
      logger.error('Failed to parse Gemini JSON response', {
        requestId: req.requestId,
        error: parseError,
        rawResponse: cleanedText,
      });
      // Fallback if JSON parsing fails but we have some text
      res.status(500).json({
        success: false,
        message: 'Failed to parse the translation response.',
        // providing the raw text might help debug, but could be messy
        raw: cleanedText,
      });
    }

  } catch (error) {
    logger.error('Gemini API call failed', {
      requestId: req.requestId,
      error: error,
    });
    res.status(500).json({ success: false, message: 'An error occurred while translating.' });
  }
}));

export default router;
