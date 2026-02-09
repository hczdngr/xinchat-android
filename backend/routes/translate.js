
import express from 'express';
import { GoogleGenAI } from '@google/genai';
import { logger } from '../observability.js';

const router = express.Router();

// Initialize Google Generative AI
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  logger.warn('GEMINI_API_KEY is not set. Translation API will not work.');
}
const genAI = apiKey ? new GoogleGenAI(apiKey) : null;
const model = genAI ? genAI.getGenerativeModel({ model: 'gemini-pro' }) : null;

router.post('/', async (req, res) => {
  if (!model) {
    return res.status(503).json({
      success: false,
      message: 'Translation service is not configured on the server.',
    });
  }

  const { text } = req.body;
  if (!text || typeof text !== 'string') {
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
      res.json({ success: true, ...jsonResponse });
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
        raw: cleanedText
      });
    }

  } catch (error) {
    logger.error('Gemini API call failed', {
      requestId: req.requestId,
      error: error,
    });
    res.status(500).json({ success: false, message: 'An error occurred while translating.' });
  }
});

export default router;
