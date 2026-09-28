import express from 'express';
import ToolRegistry from '../models/ToolRegistry.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const tools = await ToolRegistry.find();
    return res.status(200).json(tools);
  } catch (error) {
    console.error('[Tools] Error listing tools:', error);
    return res.status(500).json({ status: 'failed', error: 'An internal error occurred while listing tools.' });
  }
});

export default router;
